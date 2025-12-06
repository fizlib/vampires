const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// In-memory game storage
const games = {};

// Helper: Shuffle Array
const shuffle = (array) => array.sort(() => Math.random() - 0.5);

class Game {
  constructor(code, hostId, settings) {
    this.code = code;
    this.host = hostId;
    this.players = []; // { id, name, role, alignment, alive, socketId }
    this.state = 'LOBBY'; // LOBBY, NIGHT, DAY_DISCUSS, DAY_VOTE, GAME_OVER
    this.round = 0;
    this.settings = settings; // { discussionTime, nightTime, revealRole }
    this.timer = 0;
    this.interval = null;
    
    // Game State Data
    this.nightActions = {}; // { playerId: { targetId, actionType } }
    this.votes = {}; // { voterId: targetId }
    this.winner = null; // 'GOOD', 'EVIL', 'JESTER'
    this.logs = []; // Public game logs
  }

  addPlayer(id, name, socketId) {
    this.players.push({ 
      id, name, socketId, 
      role: null, alignment: null, 
      alive: true, isTurned: false 
    });
  }

  start() {
    this.assignRoles();
    this.startNight();
  }

  assignRoles() {
    const total = this.players.length;
    let pool = [];

    // Calculate counts
    const investCount = Math.max(1, Math.floor(total * 0.1));
    const lookoutCount = Math.max(1, Math.floor(total * 0.1));
    const vampCount = Math.max(1, Math.floor(total * 0.1));
    const jesterCount = 1; 
    
    // Add roles to pool
    for(let i=0; i<investCount; i++) pool.push({role: 'Investigator', align: 'good'});
    for(let i=0; i<lookoutCount; i++) pool.push({role: 'Lookout', align: 'good'});
    for(let i=0; i<vampCount; i++) pool.push({role: 'Vampire', align: 'evil'});
    for(let i=0; i<jesterCount; i++) pool.push({role: 'Jester', align: 'neutral'});

    // Fill rest with Citizens
    while(pool.length < total) {
      pool.push({role: 'Citizen', align: 'good'});
    }

    pool = shuffle(pool);

    this.players.forEach((p, i) => {
      p.role = pool[i].role;
      p.alignment = pool[i].align;
    });
  }

  startNight() {
    this.state = 'NIGHT';
    this.round++;
    this.nightActions = {};
    this.votes = {};
    this.startTimer(this.settings.nightTime, () => this.resolveNight());
  }

  resolveNight() {
    // Logic Resolution
    let kills = [];
    let visits = {}; // targetId: [visitorNames]
    let investigationResults = {}; // investigatorId: roleString

    // 1. Process Visits (Who went where)
    Object.values(this.nightActions).forEach(action => {
      const { actorId, targetId } = action;
      if (!visits[targetId]) visits[targetId] = [];
      const actor = this.players.find(p => p.id === actorId);
      visits[targetId].push(actor.name);
    });

    // 2. Vampire Logic (Vote or Last Action)
    // Vampires can turn every OTHER night (e.g., Night 2, 4...) OR Night 1? 
    // Prompt: "Every other night". Let's assume Night 2, 4, 6...
    // If round 1, vamps do nothing or just chat. Let's make it Night 2+ for balance.
    // If vampAction is allowed:
    const canTurn = (this.round % 2 === 0);
    
    if (canTurn) {
        // Find vampire target (simple majority or last pick)
        const vampActions = Object.values(this.nightActions).filter(a => a.type === 'BITE');
        if (vampActions.length > 0) {
            // Pick the last one for MVP simplicity
            const targetId = vampActions[vampActions.length - 1].targetId;
            const target = this.players.find(p => p.id === targetId);
            if (target && target.alive) {
                target.role = 'Vampire';
                target.alignment = 'evil';
                target.isTurned = true; // Mark as turned
                // Note: In this variant, they are turned, not killed.
                this.logs.push(`A dark ritual took place... someone's nature has changed.`);
            }
        }
    }

    // 3. Investigator Logic
    Object.keys(this.nightActions).forEach(actorId => {
        const action = this.nightActions[actorId];
        if (action.type === 'INVESTIGATE') {
            const target = this.players.find(p => p.id === action.targetId);
            investigationResults[actorId] = target ? target.role : 'Unknown';
        }
    });

    // 4. Lookout Logic
    Object.keys(this.nightActions).forEach(actorId => {
        const action = this.nightActions[actorId];
        if (action.type === 'LOOKOUT') {
            const visitors = visits[action.targetId] || [];
            // Remove self from visitors list if any
            const actorName = this.players.find(p => p.id === actorId).name;
            const filtered = visitors.filter(name => name !== actorName);
            investigationResults[actorId] = filtered.length > 0 
                ? `Visited by: ${filtered.join(', ')}` 
                : 'No one visited.';
        }
    });

    // Send private results
    Object.keys(investigationResults).forEach(pId => {
        const player = this.players.find(p => p.id === pId);
        if(player) io.to(player.socketId).emit('private_message', investigationResults[pId]);
    });

    this.checkWinCondition();
    if(this.state !== 'GAME_OVER') this.startDayDiscuss();
  }

  startDayDiscuss() {
    this.state = 'DAY_DISCUSS';
    this.startTimer(this.settings.discussionTime, () => this.startDayVote());
  }

  startDayVote() {
    this.state = 'DAY_VOTE';
    this.votes = {};
    this.startTimer(15, () => this.resolveVoting());
  }

  resolveVoting() {
    // Count votes
    const counts = {};
    Object.values(this.votes).forEach(targetId => {
        counts[targetId] = (counts[targetId] || 0) + 1;
    });

    let lynchedId = null;
    const livingCount = this.players.filter(p => p.alive).length;
    
    // Find who got > 50%
    for (const [targetId, count] of Object.entries(counts)) {
        if (count > livingCount / 2) {
            lynchedId = targetId;
            break;
        }
    }

    if (lynchedId) {
        const victim = this.players.find(p => p.id === lynchedId);
        victim.alive = false;
        this.logs.push(`${victim.name} was lynched!`);
        
        // Jester Win Check
        if (victim.role === 'Jester') {
            this.state = 'GAME_OVER';
            this.winner = 'Jester';
            this.logs.push(`The Jester has been lynched! Jester Wins!`);
            this.broadcastUpdate();
            return;
        }

        if (this.settings.revealRole) {
            this.logs.push(`${victim.name} was a ${victim.role}`);
        }
    } else {
        this.logs.push("No one received enough votes to be lynched.");
    }

    this.checkWinCondition();
    if(this.state !== 'GAME_OVER') this.startNight();
  }

  checkWinCondition() {
    const living = this.players.filter(p => p.alive);
    const vamps = living.filter(p => p.alignment === 'evil');
    const good = living.filter(p => p.alignment === 'good');

    if (vamps.length === 0) {
        this.state = 'GAME_OVER';
        this.winner = 'GOOD';
    } else if (vamps.length >= living.length / 2) {
        this.state = 'GAME_OVER';
        this.winner = 'EVIL';
    }
  }

  startTimer(seconds, callback) {
    if (this.interval) clearInterval(this.interval);
    this.timer = seconds;
    this.broadcastUpdate();
    
    this.interval = setInterval(() => {
        this.timer--;
        if (this.timer <= 0) {
            clearInterval(this.interval);
            callback();
        }
        // Optimize: Don't broadcast every second if generic, but for game sync we will
        this.broadcastUpdate();
    }, 1000);
  }

  broadcastUpdate() {
    // Sanitize data based on receiver is hard in broad cast, 
    // so we send generic data and private data separately.
    const publicState = {
        code: this.code,
        state: this.state,
        round: this.round,
        timer: this.timer,
        logs: this.logs,
        players: this.players.map(p => ({
            id: p.id, 
            name: p.name, 
            alive: p.alive, 
            votes: this.countVotesFor(p.id) // Helper to show vote counts
        }))
    };
    
    io.to(this.code).emit('game_update', publicState);
  }

  countVotesFor(pid) {
      if (this.state !== 'DAY_VOTE') return 0;
      return Object.values(this.votes).filter(v => v === pid).length;
  }
}

// Socket Handlers
io.on('connection', (socket) => {
    
    socket.on('create_game', ({ name, settings }) => {
        const code = Math.random().toString(36).substring(2, 7).toUpperCase();
        const game = new Game(code, socket.id, settings);
        game.addPlayer(socket.id, name, socket.id);
        games[code] = game;
        socket.join(code);
        socket.emit('game_created', { code, playerId: socket.id });
        game.broadcastUpdate();
    });

    socket.on('join_game', ({ code, name }) => {
        const game = games[code];
        if (game && game.state === 'LOBBY') {
            game.addPlayer(socket.id, name, socket.id);
            socket.join(code);
            socket.emit('joined', { code, playerId: socket.id });
            game.broadcastUpdate();
        } else {
            socket.emit('error', 'Game not found or started');
        }
    });

    socket.on('start_game', ({ code }) => {
        const game = games[code];
        if (game && game.host === socket.id) {
            game.start();
            // Send roles privately
            game.players.forEach(p => {
                io.to(p.socketId).emit('role_info', { role: p.role, alignment: p.alignment });
            });
            game.broadcastUpdate();
        }
    });

    socket.on('night_action', ({ code, action }) => {
        // action: { targetId, type }
        const game = games[code];
        if (game && game.state === 'NIGHT') {
            game.nightActions[socket.id] = { ...action, actorId: socket.id };
        }
    });

    socket.on('day_vote', ({ code, targetId }) => {
        const game = games[code];
        if (game && game.state === 'DAY_VOTE') {
            // Check if player is alive
            const p = game.players.find(pl => pl.id === socket.id);
            if(p && p.alive) {
                game.votes[socket.id] = targetId;
                game.broadcastUpdate();
            }
        }
    });
});

server.listen(3001, () => {
  console.log('Server running on 3001');
});