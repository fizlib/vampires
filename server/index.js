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

// In-memory storage
const games = {};

// Helper: Shuffle
const shuffle = (array) => array.sort(() => Math.random() - 0.5);

// Random NPC name generator
const generateNPCName = () => {
  const adjectives = ['Shadow', 'Dark', 'Blood', 'Night', 'Crimson', 'Silent', 'Mystic', 'Ancient', 'Pale', 'Eternal', 'Grim', 'Hollow', 'Frost', 'Ember', 'Storm'];
  const nouns = ['Hunter', 'Walker', 'Stalker', 'Slayer', 'Seeker', 'Watcher', 'Phantom', 'Specter', 'Raven', 'Wolf', 'Crow', 'Shade', 'Wraith', 'Spirit', 'Ghost'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
};

class Game {
  constructor(code, hostPlayerId, settings) {
    this.code = code;
    this.host = hostPlayerId; // This is the player ID of the host (persistent)
    this.players = [];
    this.state = 'LOBBY';
    this.round = 0;
    this.settings = settings;
    this.timer = 0;
    this.interval = null;
    this.nightActions = {};
    this.votes = {};
    this.winner = null;
    this.logs = [];
  }

  addPlayer(id, name, socketId) {
    const existing = this.players.find(p => p.id === id);
    if (existing) {
      // Update socket if player reconnects
      existing.socketId = socketId;
      existing.connected = true;
      return existing;
    }
    const newPlayer = {
      id, name, socketId,
      role: null, alignment: null,
      alive: true, isTurned: false, connected: true,
      isNPC: false
    };
    this.players.push(newPlayer);
    return newPlayer;
  }

  addNPC() {
    const id = 'npc_' + Math.random().toString(36).substr(2, 9);
    const name = '[NPC] ' + generateNPCName();
    const npcPlayer = {
      id, name, socketId: null,
      role: null, alignment: null,
      alive: true, isTurned: false, connected: true,
      isNPC: true
    };
    this.players.push(npcPlayer);
    return npcPlayer;
  }

  removePlayer(playerId) {
    this.players = this.players.filter(p => p.id !== playerId);
  }

  assignRoles() {
    const total = this.players.length;
    let pool = [];

    // Role alignment mapping
    const roleAlignments = {
      'Investigator': 'good',
      'Lookout': 'good',
      'Citizen': 'good',
      'Vampire': 'evil',
      'Jester': 'neutral'
    };

    // Check if custom role configuration is provided
    if (this.settings.roleConfig && !this.settings.roleConfig.useDefault) {
      const config = this.settings.roleConfig;

      // Add roles based on custom configuration
      for (let i = 0; i < (config.Investigator || 0); i++) {
        pool.push({ role: 'Investigator', align: roleAlignments['Investigator'] });
      }
      for (let i = 0; i < (config.Lookout || 0); i++) {
        pool.push({ role: 'Lookout', align: roleAlignments['Lookout'] });
      }
      for (let i = 0; i < (config.Vampire || 0); i++) {
        pool.push({ role: 'Vampire', align: roleAlignments['Vampire'] });
      }
      for (let i = 0; i < (config.Jester || 0); i++) {
        pool.push({ role: 'Jester', align: roleAlignments['Jester'] });
      }

      // Fill remaining slots with Citizens
      while (pool.length < total) {
        pool.push({ role: 'Citizen', align: roleAlignments['Citizen'] });
      }

      // If we have more roles than players, trim the pool
      if (pool.length > total) {
        pool = shuffle(pool).slice(0, total);
      }
    } else {
      // Default calculation based on percentages
      const investCount = Math.max(1, Math.floor(total * 0.1));
      const lookoutCount = Math.max(1, Math.floor(total * 0.1));
      const vampCount = Math.max(1, Math.floor(total * 0.1));
      const jesterCount = 1;

      for (let i = 0; i < investCount; i++) pool.push({ role: 'Investigator', align: 'good' });
      for (let i = 0; i < lookoutCount; i++) pool.push({ role: 'Lookout', align: 'good' });
      for (let i = 0; i < vampCount; i++) pool.push({ role: 'Vampire', align: 'evil' });
      for (let i = 0; i < jesterCount; i++) pool.push({ role: 'Jester', align: 'neutral' });

      while (pool.length < total) pool.push({ role: 'Citizen', align: 'good' });
    }

    pool = shuffle(pool);

    this.players.forEach((p, i) => {
      p.role = pool[i].role;
      p.alignment = pool[i].align;
    });
  }

  start() {
    this.assignRoles();
    this.startNight();
  }

  startNight() {
    this.state = 'NIGHT';
    this.round++;
    this.nightActions = {};
    this.votes = {};
    this.broadcastUpdate();
    this.startTimer(this.settings.nightTime, () => this.resolveNight());
  }

  resolveNight() {
    let visits = {};
    let investigationResults = {};

    // 1. Process Visits
    Object.values(this.nightActions).forEach(action => {
      const { actorId, targetId } = action;
      if (!visits[targetId]) visits[targetId] = [];
      const actor = this.players.find(p => p.id === actorId);
      if (actor) visits[targetId].push(actor.name);
    });

    // 2. Vampire Logic (Every other night, starting night 2)
    const canTurn = (this.round % 2 === 0);
    if (canTurn) {
      const vampActions = Object.values(this.nightActions).filter(a => a.type === 'BITE');
      if (vampActions.length > 0) {
        // Last bite counts
        const targetId = vampActions[vampActions.length - 1].targetId;
        const target = this.players.find(p => p.id === targetId);
        if (target && target.alive) {
          target.role = 'Vampire';
          target.alignment = 'evil';
          target.isTurned = true;
          this.logs.push(`A dark ritual took place... someone's nature has changed.`);
        }
      }
    }

    // 3. Investigator
    Object.keys(this.nightActions).forEach(actorId => {
      const action = this.nightActions[actorId];
      if (action.type === 'INVESTIGATE') {
        const target = this.players.find(p => p.id === action.targetId);
        investigationResults[actorId] = target ? `Target is a ${target.role}` : 'Unknown';
      }
    });

    // 4. Lookout
    Object.keys(this.nightActions).forEach(actorId => {
      const action = this.nightActions[actorId];
      if (action.type === 'LOOKOUT') {
        const visitors = visits[action.targetId] || [];
        const actorName = this.players.find(p => p.id === actorId)?.name;
        const filtered = visitors.filter(name => name !== actorName);
        investigationResults[actorId] = filtered.length > 0
          ? `Visited by: ${filtered.join(', ')}`
          : 'No one visited.';
      }
    });

    // Send private results
    Object.keys(investigationResults).forEach(pId => {
      const player = this.players.find(p => p.id === pId);
      if (player) io.to(player.socketId).emit('private_message', investigationResults[pId]);
    });

    this.checkWinCondition();
    if (this.state !== 'GAME_OVER') this.startDayDiscuss();
  }

  startDayDiscuss() {
    this.state = 'DAY_DISCUSS';
    this.broadcastUpdate();
    this.startTimer(this.settings.discussionTime, () => this.startDayVote());
  }

  startDayVote() {
    this.state = 'DAY_VOTE';
    this.votes = {};
    this.broadcastUpdate();
    this.startTimer(15, () => this.resolveVoting());
  }

  resolveVoting() {
    const counts = {};
    Object.values(this.votes).forEach(targetId => {
      counts[targetId] = (counts[targetId] || 0) + 1;
    });

    let lynchedId = null;
    const livingCount = this.players.filter(p => p.alive).length;

    // Strict majority > 50%
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

      if (victim.role === 'Jester') {
        this.state = 'GAME_OVER';
        this.winner = 'Jester';
        this.logs.push(`The Jester was lynched! Jester Wins!`);
        this.broadcastUpdate();
        return;
      }

      if (this.settings.revealRole) {
        this.logs.push(`${victim.name} was a ${victim.role}`);
      }
    } else {
      this.logs.push("No one received enough votes.");
    }

    this.checkWinCondition();
    if (this.state !== 'GAME_OVER') this.startNight();
  }

  checkWinCondition() {
    const living = this.players.filter(p => p.alive);
    const vamps = living.filter(p => p.alignment === 'evil');

    if (vamps.length === 0) {
      this.state = 'GAME_OVER';
      this.winner = 'GOOD';
      if (this.interval) clearInterval(this.interval);
      this.logs.push('The vampires have been eliminated! Good wins!');
      this.broadcastUpdate();
    } else if (vamps.length >= living.length / 2) {
      this.state = 'GAME_OVER';
      this.winner = 'EVIL';
      if (this.interval) clearInterval(this.interval);
      this.logs.push('The vampires have taken over! Evil wins!');
      this.broadcastUpdate();
    }
  }

  startTimer(seconds, callback) {
    if (this.interval) clearInterval(this.interval);
    this.timer = seconds;
    this.timerCallback = callback; // Store callback for skip
    this.broadcastUpdate();

    this.interval = setInterval(() => {
      this.timer--;
      if (this.timer <= 0) {
        clearInterval(this.interval);
        this.timerCallback = null;
        callback();
      }
      // Sync timer occasionally or every second
      io.to(this.code).emit('timer_update', this.timer);
    }, 1000);
  }

  skipTimer() {
    if (this.interval) {
      clearInterval(this.interval);
      this.timer = 0;
      io.to(this.code).emit('timer_update', 0);
      if (this.timerCallback) {
        const cb = this.timerCallback;
        this.timerCallback = null;
        cb();
      }
    }
  }

  endGame(winner = 'Host Ended') {
    if (this.interval) clearInterval(this.interval);
    this.state = 'GAME_OVER';
    this.winner = winner;
    this.logs.push('The host has ended the game.');
    this.broadcastUpdate();
  }

  broadcastUpdate() {
    // Build base public state
    const baseState = {
      code: this.code,
      host: this.host,
      state: this.state,
      round: this.round,
      timer: this.timer,
      logs: this.logs
    };

    // Get vampire player IDs for night phase visibility
    const vampireIds = this.state === 'NIGHT'
      ? this.players.filter(p => p.role === 'Vampire' && p.alive).map(p => p.id)
      : [];

    // Send personalized state to each player
    this.players.forEach(player => {
      const isVampire = player.role === 'Vampire';
      const playerState = {
        ...baseState,
        players: this.players.map(p => ({
          id: p.id,
          name: p.name,
          alive: p.alive,
          votes: this.countVotesFor(p.id),
          isNPC: p.isNPC || false,
          // Show vampire status to other vampires during night
          isVampire: (isVampire && this.state === 'NIGHT') ? (p.role === 'Vampire') : undefined
        }))
      };
      if (player.socketId) {
        io.to(player.socketId).emit('game_update', playerState);
      }
    });
  }

  countVotesFor(pid) {
    if (this.state !== 'DAY_VOTE') return 0;
    return Object.values(this.votes).filter(v => v === pid).length;
  }
}

io.on('connection', (socket) => {

  // --- REJOIN LOGIC ---
  socket.on('rejoin_game', ({ code, playerId }) => {
    const game = games[code];
    if (game) {
      const player = game.players.find(p => p.id === playerId);
      if (player) {
        player.socketId = socket.id; // Update socket
        player.connected = true;
        socket.join(code);

        // If game is in progress, send role info again
        if (game.state !== 'LOBBY') {
          socket.emit('role_info', { role: player.role, alignment: player.alignment });
        }

        socket.emit('joined', { code, playerId });
        game.broadcastUpdate();
      } else {
        socket.emit('error', 'Player not found in this game.');
      }
    } else {
      socket.emit('error', 'Game no longer exists.');
    }
  });

  // --- CREATE ---
  socket.on('create_game', ({ name, settings }) => {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    const playerId = Math.random().toString(36).substr(2, 9); // Generate stable ID

    const game = new Game(code, playerId, settings); // Use playerId as host (persistent)
    game.addPlayer(playerId, name, socket.id);
    games[code] = game;

    socket.join(code);
    socket.emit('game_created', { code, playerId });
    game.broadcastUpdate();
  });

  // --- JOIN ---
  socket.on('join_game', ({ code, name }) => {
    const game = games[code];
    if (game && game.state === 'LOBBY') {
      const playerId = Math.random().toString(36).substr(2, 9);
      game.addPlayer(playerId, name, socket.id);
      socket.join(code);
      socket.emit('joined', { code, playerId });
      game.broadcastUpdate();
    } else {
      socket.emit('error', 'Game not found or started');
    }
  });

  // --- KICK (Host Only) ---
  socket.on('kick_player', ({ code, targetId }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id) {
      // Find target socket to notify them
      const target = game.players.find(p => p.id === targetId);
      if (target) {
        io.to(target.socketId).emit('kicked');
        io.sockets.sockets.get(target.socketId)?.leave(code); // Force leave room
      }
      game.removePlayer(targetId);
      game.broadcastUpdate();
    }
  });

  socket.on('start_game', ({ code, roleConfig }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id) {
      // Update roleConfig in settings before starting
      if (roleConfig) {
        game.settings.roleConfig = roleConfig;
      }
      game.start();
      game.players.forEach(p => {
        io.to(p.socketId).emit('role_info', { role: p.role, alignment: p.alignment });
      });
      game.broadcastUpdate();
    }
  });

  socket.on('night_action', ({ code, action }) => {
    const game = games[code];
    // We need to find the player ID associated with this socket
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && game.state === 'NIGHT' && player) {
      // Validate BITE action - vampires can't target other vampires
      if (action.type === 'BITE') {
        const target = game.players.find(p => p.id === action.targetId);
        if (target && target.role === 'Vampire') {
          socket.emit('private_message', 'Cannot turn a fellow vampire!');
          return;
        }
      }
      game.nightActions[player.id] = { ...action, actorId: player.id };
    }
  });

  socket.on('day_vote', ({ code, targetId }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && game.state === 'DAY_VOTE' && player && player.alive) {
      game.votes[player.id] = targetId;
      game.broadcastUpdate();
    }
  });

  // --- HOST: SKIP TIMER ---
  socket.on('skip_timer', ({ code }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id && game.state !== 'LOBBY' && game.state !== 'GAME_OVER') {
      game.skipTimer();
    }
  });

  // --- HOST: END GAME ---
  socket.on('end_game', ({ code }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id) {
      game.endGame();
    }
  });

  // --- HOST: ADD NPC ---
  socket.on('add_npc', ({ code }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id && game.state === 'LOBBY') {
      game.addNPC();
      game.broadcastUpdate();
    }
  });

  // --- HOST: GET PLAYER ROLE ---
  socket.on('get_player_role', ({ code, targetId }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id) {
      const target = game.players.find(p => p.id === targetId);
      if (target) {
        socket.emit('player_role_info', {
          playerId: target.id,
          name: target.name,
          role: target.role,
          alignment: target.alignment,
          isNPC: target.isNPC
        });
      }
    }
  });
});

// Listen on 0.0.0.0 to accept connections from all network interfaces
// This allows other devices on the network to connect via your IP address
server.listen(3001, '0.0.0.0', () => {
  console.log('Server running on port 3001 (accessible from all interfaces)');
});