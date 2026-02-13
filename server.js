// server.js — полный бэкенд для Render
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 10000;

// HTTP сервер (Render требует ответ на HTTP для health checks)
const server = http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*'
    });
    res.end('Game server running');
});

// WebSocket сервер
const wss = new WebSocket.Server({ server });

// Игровой мир
const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;
const PLAYER_SPEED = 250;
const PLAYER_RADIUS = 20;
const EAT_DISTANCE = 60;
const EAT_COOLDOWN = 30; // секунд
const EAT_WINDUP = 3; // секунды подготовки
const HOUSE_SIZE = 60;

// Генерация домов (одинаковые для всех)
const houses = [];
for (let i = 0; i < 15; i++) {
    houses.push({
        id: i,
        x: 100 + Math.random() * (WORLD_WIDTH - 200),
        y: 100 + Math.random() * (WORLD_HEIGHT - 200)
    });
}

// Игроки
const players = new Map(); // id -> player

class Player {
    constructor(id, ws, name, color) {
        this.id = id;
        this.ws = ws;
        this.name = name;
        this.color = color;
        this.x = WORLD_WIDTH / 2 + (Math.random() - 0.5) * 200;
        this.y = WORLD_HEIGHT / 2 + (Math.random() - 0.5) * 200;
        this.vx = 0;
        this.vy = 0;
        this.radius = PLAYER_RADIUS;
        this.eatCount = 0;
        this.dead = false;
        this.inHouse = null;
        this.lastEatTime = 0; // когда последний раз ел
        this.eatWindupStart = null; // когда начал "заряжать" съедение
        this.eatTarget = null; // кого пытается съесть
        this.lastPing = Date.now();
    }

    canEat() {
        return !this.dead && 
               !this.inHouse && 
               (Date.now() - this.lastEatTime) > EAT_COOLDOWN * 1000;
    }

    getCooldownRemaining() {
        const remaining = EAT_COOLDOWN * 1000 - (Date.now() - this.lastEatTime);
        return Math.max(0, Math.ceil(remaining / 1000));
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            color: this.color,
            x: this.x,
            y: this.y,
            vx: this.vx,
            vy: this.vy,
            radius: this.radius,
            eatCount: this.eatCount,
            dead: this.dead,
            inHouse: this.inHouse,
            cooldown: this.getCooldownRemaining(),
            windup: this.eatWindupStart ? Math.ceil((EAT_WINDUP * 1000 - (Date.now() - this.eatWindupStart)) / 1000) : 0
        };
    }
}

// Рассылка всем
function broadcast(data, excludeId = null) {
    const msg = JSON.stringify(data);
    players.forEach((player, id) => {
        if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(msg);
        }
    });
}

// Отправка одному
function sendTo(playerId, data) {
    const player = players.get(playerId);
    if (player && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(data));
    }
}

// Проверка съедения
function checkEatAttempt(predator) {
    if (!predator.eatWindupStart || !predator.eatTarget) return;
    
    const elapsed = (Date.now() - predator.eatWindupStart) / 1000;
    if (elapsed < EAT_WINDUP) return; // Ещё заряжается

    const victim = players.get(predator.eatTarget);
    if (!victim || victim.dead || victim.inHouse) {
        // Жертва убежала или спряталась
        predator.eatWindupStart = null;
        predator.eatTarget = null;
        return;
    }

    // Проверяем дистанцию
    const dx = victim.x - predator.x;
    const dy = victim.y - predator.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= EAT_DISTANCE + predator.radius * 0.5) {
        // Успешно съели!
        victim.dead = true;
        predator.eatCount++;
        predator.radius = PLAYER_RADIUS + predator.eatCount * 3; // Рост
        predator.lastEatTime = Date.now();
        
        // Уведомляем жертву
        sendTo(victim.id, {
            type: 'eaten_by',
            predatorId: predator.id,
            predatorName: predator.name
        });

        // Уведомляем хищника
        sendTo(predator.id, {
            type: 'you_ate',
            victimId: victim.id,
            victimName: victim.name,
            newRadius: predator.radius
        });

        // Всем остальным
        broadcast({
            type: 'player_eaten',
            victimId: victim.id,
            predatorId: predator.id
        });

        // Респавн жертвы через 3 сек
        setTimeout(() => {
            if (players.has(victim.id)) {
                victim.dead = false;
                victim.x = Math.random() * WORLD_WIDTH;
                victim.y = Math.random() * WORLD_HEIGHT;
                victim.inHouse = null;
                sendTo(victim.id, { type: 'respawn' });
                broadcast({
                    type: 'player_respawned',
                    playerId: victim.id,
                    x: victim.x,
                    y: victim.y
                });
            }
        }, 3000);
    }

    // Сбрасываем windup
    predator.eatWindupStart = null;
    predator.eatTarget = null;
}

// Игровой цикл (20 тиков в секунду)
setInterval(() => {
    const now = Date.now();
    
    // Обновляем позиции и проверяем съедения
    players.forEach((player, id) => {
        if (player.dead) return;

        // Обновляем позицию
        player.x += player.vx * 0.05; // 0.05 = 1/20 секунды
        player.y += player.vy * 0.05;

        // Границы мира
        player.x = Math.max(player.radius, Math.min(WORLD_WIDTH - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(WORLD_HEIGHT - player.radius, player.y));

        // Коллизия с домами
        if (!player.inHouse) {
            for (let house of houses) {
                if (player.x + player.radius > house.x && 
                    player.x - player.radius < house.x + HOUSE_SIZE &&
                    player.y + player.radius > house.y && 
                    player.y - player.radius < house.y + HOUSE_SIZE) {
                    // Отталкиваем
                    const hcx = house.x + HOUSE_SIZE/2;
                    const hcy = house.y + HOUSE_SIZE/2;
                    const dx = player.x - hcx;
                    const dy = player.y - hcy;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist > 0) {
                        player.x = hcx + (dx/dist) * (HOUSE_SIZE/2 + player.radius + 2);
                        player.y = hcy + (dy/dist) * (HOUSE_SIZE/2 + player.radius + 2);
                    }
                }
            }
        }

        // Проверяем windup съедения
        if (player.eatWindupStart) {
            checkEatAttempt(player);
        }

        // Проверяем отключение (ping timeout)
        if (now - player.lastPing > 30000) {
            player.ws.close();
        }
    });

    // Отправляем состояние всем
    const state = {
        type: 'state',
        players: Array.from(players.values()).map(p => p.toJSON()),
        houses: houses,
        timestamp: now
    };
    
    broadcast(state);
}, 50); // 50ms = 20fps

// Подключения
wss.on('connection', (ws) => {
    const playerId = Math.random().toString(36).substr(2, 9);
    console.log(`Player connected: ${playerId}`);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const player = players.get(playerId);
            if (!player && msg.type !== 'join') return;

            switch (msg.type) {
                case 'join':
                    if (players.has(playerId)) return;
                    const newPlayer = new Player(playerId, ws, msg.name, msg.color);
                    players.set(playerId, newPlayer);
                    
                    // Отправляем начальное состояние
                    ws.send(JSON.stringify({
                        type: 'init',
                        playerId: playerId,
                        houses: houses,
                        players: Array.from(players.values()).map(p => p.toJSON())
                    }));

                    // Уведомляем остальных
                    broadcast({
                        type: 'player_joined',
                        player: newPlayer.toJSON()
                    }, playerId);
                    break;

                case 'move':
                    if (player.dead || player.inHouse) {
                        player.vx = 0;
                        player.vy = 0;
                        return;
                    }
                    player.vx = msg.vx || 0;
                    player.vy = msg.vy || 0;
                    break;

                case 'eat_start':
                    if (!player.canEat() || player.dead || player.inHouse) {
                        ws.send(JSON.stringify({ type: 'eat_failed', reason: 'cooldown or dead' }));
                        return;
                    }

                    // Ищем ближайшую жертву
                    let closest = null;
                    let closestDist = Infinity;
                    
                    players.forEach((other, otherId) => {
                        if (otherId === playerId || other.dead || other.inHouse) return;
                        const dx = other.x - player.x;
                        const dy = other.y - player.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        if (dist < EAT_DISTANCE + player.radius && dist < closestDist) {
                            closest = other;
                            closestDist = dist;
                        }
                    });

                    if (closest) {
                        player.eatWindupStart = Date.now();
                        player.eatTarget = closest.id;
                        
                        // Уведомляем жертву о попытке съесть
                        sendTo(closest.id, {
                            type: 'eat_attempt',
                            predatorId: player.id,
                            predatorName: player.name,
                            duration: EAT_WINDUP
                        });

                        // Уведомляем хищника
                        ws.send(JSON.stringify({
                            type: 'eat_windup_started',
                            targetId: closest.id,
                            duration: EAT_WINDUP
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'eat_failed', reason: 'no target' }));
                    }
                    break;

                case 'eat_cancel':
                    if (player.eatWindupStart) {
                        // Уведомляем жертву об отмене
                        if (player.eatTarget) {
                            sendTo(player.eatTarget, {
                                type: 'eat_cancelled',
                                predatorId: player.id
                            });
                        }
                        player.eatWindupStart = null;
                        player.eatTarget = null;
                    }
                    break;

                case 'enter_house':
                    const house = houses[msg.houseId];
                    if (!house) return;
                    
                    const dx = player.x - (house.x + HOUSE_SIZE/2);
                    const dy = player.y - (house.y + HOUSE_SIZE/2);
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    
                    if (dist < 50) {
                        if (player.inHouse === msg.houseId) {
                            // Выходим
                            player.inHouse = null;
                            player.x = house.x + HOUSE_SIZE + 30;
                            player.y = house.y + HOUSE_SIZE/2;
                        } else if (player.inHouse === null) {
                            // Заходим
                            player.inHouse = msg.houseId;
                            player.x = house.x + HOUSE_SIZE/2;
                            player.y = house.y + HOUSE_SIZE/2;
                            player.vx = 0;
                            player.vy = 0;
                        }
                        
                        broadcast({
                            type: 'player_moved',
                            playerId: playerId,
                            x: player.x,
                            y: player.y,
                            inHouse: player.inHouse
                        });
                    }
                    break;

                case 'ping':
                    player.lastPing = Date.now();
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        console.log(`Player disconnected: ${playerId}`);
        players.delete(playerId);
        broadcast({
            type: 'player_left',
            playerId: playerId
        });
    });

    ws.on('error', (err) => {
        console.error(`WebSocket error for ${playerId}:`, err);
    });
});

server.listen(PORT, () => {
    console.log(`Game server running on port ${PORT}`);
});
