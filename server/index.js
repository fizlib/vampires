require('dotenv').config({ override: true });
require('dotenv').config({ override: true });

const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const AIController = require('./ai');
const GoogleTTSController = require('./tts');
const ElevenLabsTTSController = require('./elevenlabs-tts');
const GoogleSTTController = require('./stt');

// Initialize TTS controllers (singletons) if credentials are available
const googleTTSController = new GoogleTTSController();
const elevenLabsTTSController = new ElevenLabsTTSController();

// Initialize STT controller (singleton)
const googleSTTController = new GoogleSTTController();

// Helper to get the appropriate TTS controller based on settings
function getTTSController(ttsProvider) {
  if (ttsProvider === 'elevenlabs') {
    return elevenLabsTTSController.isAvailable() ? elevenLabsTTSController : null;
  }
  // Default to Google TTS
  return googleTTSController.isAvailable() ? googleTTSController : null;
}

// Load API key from env or use empty string (will fail gracefully if not present)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const app = express();
app.use(cors());

// Create server - use HTTP for now (HTTPS causes certificate issues)
// The simplest solution is to keep the server on HTTP and handle HTTPS at the client level
const server = http.createServer(app);
const protocol = 'http';

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
    // Jailor state
    this.jailedPlayerId = null;
    this.jailorId = null;
    this.jailorPendingDeath = false;
    this.jailChat = [];
    // Vampire Framer state
    this.framedPlayers = {};
    // Game chat state
    this.gameChat = [];

    this.npcChatCooldowns = {}; // Tracks last message time per NPC to prevent spam
    this.NPC_CHAT_COOLDOWN_MS = 5000; // 5 second cooldown between NPC messages

    // AI Controller
    if (this.settings.enableAI && GEMINI_API_KEY) {
      this.ai = new AIController(GEMINI_API_KEY, this.settings.npcNationality || 'english');
    } else {
      this.ai = null;
    }

    // TTS Controller reference (uses global helper to select provider)
    this.tts = this.settings.enableTTS ? getTTSController(this.settings.ttsProvider) : null;

    // STT Controller reference
    this.stt = this.settings.enableSTT ? googleSTTController : null;
  }

  // Trigger AI Actions
  async triggerAIActions() {
    if (!this.ai) {
      console.log("[Game] AI not enabled or not initialized.");
      return;
    }

    const npcPlayers = this.players.filter(p => p.isNPC && p.alive);
    console.log(`[Game] Triggering AI Actions for ${npcPlayers.length} NPCs in phase ${this.state}`);

    if (npcPlayers.length === 0) return;

    // Night Actions
    if (this.state === 'NIGHT') {
      for (const npc of npcPlayers) {
        // Random delay to simulate thinking
        setTimeout(async () => {
          if (!npc.alive) return;
          const decision = await this.ai.generateNightAction(npc, this);
          if (decision.action !== 'NONE') {
            // Find target ID by name
            const target = this.players.find(p => p.name === decision.targetName);
            const targetId = target ? target.id : null;

            // Additional logic for specific actions like EXECUTE taking no targetId or null
            const actionPayload = {
              targetId: targetId,
              type: decision.action
            };

            // Mock socket for internal action handling
            const mockSocket = {
              id: null,
              emit: () => { }
            };

            // We need to simulate the action. Since 'night_action' handler expects a socket and looks up player by socketId,
            // we might need a direct method on Game to handle actions or refactor 'night_action' to take playerId.
            // Refactoring is cleaner. For now, let's just write directly to this.nightActions if valid.

            if (decision.action === 'BITE' && targetId) {
              // Check valid target
              if (target.role !== 'Vampire' && target.role !== 'Vampire Framer') {
                this.nightActions[npc.id] = actionPayload;
              }
            } else if (decision.action === 'JAIL' && targetId && npc.role === 'Jailor') {
              // NPC Jailor jailing someone - set up jail state
              const jailTarget = this.players.find(p => p.id === targetId);
              if (jailTarget && jailTarget.alive && jailTarget.id !== npc.id) {
                this.jailedPlayerId = targetId;
                this.jailorId = npc.id;
                this.jailChat = [];
                console.log(`[Game] NPC Jailor ${npc.name} jailed ${jailTarget.name}`);

                // Notify both parties
                if (jailTarget.socketId) {
                  io.to(jailTarget.socketId).emit('private_message', '🔒 You have been jailed! The Jailor wishes to speak with you.');
                }

                this.broadcastUpdate();

                // Start interrogation after a short delay
                this.startNPCJailorInterrogation(npc, jailTarget);
              }
            } else if (targetId || decision.action === 'EXECUTE') {
              this.nightActions[npc.id] = actionPayload;
            }
          }
        }, Math.random() * 5000 + 2000); // 2-7 seconds delay
      }
    }

    // Day Voting
    if (this.state === 'DAY_VOTE') {
      const handleVote = (npc, voteName) => {
        if (voteName) {
          let target = this.players.find(p => p.name === voteName);
          if (!target) {
            target = this.players.find(p => p.name.includes(voteName) || voteName.includes(p.name));
          }
          if (target && target.alive) {
            if (this.votes[npc.id] !== target.id) {
              this.votes[npc.id] = target.id;
              console.log(`[Game] NPC ${npc.name} voted for ${target.name}`);
              this.broadcastUpdate();
            }
          }
        } else {
          // Null means unvote or abstain
          if (this.votes[npc.id]) {
            delete this.votes[npc.id];
            console.log(`[Game] NPC ${npc.name} unvoted/abstained.`);
            this.broadcastUpdate();
          }
        }
      };

      for (const npc of npcPlayers) {
        // Initial Vote
        const initialDelay = Math.random() * 4000 + 2000;

        setTimeout(async () => {
          if (!npc.alive || this.state !== 'DAY_VOTE') return;
          const res = await this.ai.generateDayVote(npc, this);
          handleVote(npc, res.vote);
        }, initialDelay);

        // 2. Re-evaluation
        setTimeout(async () => {
          if (!npc.alive || this.state !== 'DAY_VOTE') return;
          const currentTargetId = this.votes[npc.id];
          const currentTarget = currentTargetId ? this.players.find(p => p.id === currentTargetId) : null;

          const res = await this.ai.generateUpdatedVote(npc, this, currentTarget?.name || null);
          handleVote(npc, res.vote);
        }, Math.random() * 3000 + 8000);
      }
    }

    // Day Discussion (Chat) - NPCs respond to new messages instead of continuous loop
    if (this.state === 'DAY_DISCUSS') {
      // Initialize the set to track which NPCs have responded since the last non-NPC message
      this.npcRespondedSinceLastMessage = new Set();

      // Send an initial message from one random NPC to start the conversation
      if (npcPlayers.length > 0) {
        const randomNpc = npcPlayers[Math.floor(Math.random() * npcPlayers.length)];
        setTimeout(async () => {
          if (this.state !== 'DAY_DISCUSS' || !randomNpc.alive) return;
          await this.triggerNPCChatResponse(randomNpc);
        }, Math.random() * 3000 + 2000);
      }

    }
  }

  // Helper method to trigger a single NPC chat response
  async triggerNPCChatResponse(npc, isAddressed = false) {
    if (!this.ai || this.state !== 'DAY_DISCUSS' || !npc.alive) return;

    // Check cooldown to prevent spam (ignored if directly addressed)
    const now = Date.now();
    const lastMessageTime = this.npcChatCooldowns[npc.id] || 0;
    if (!isAddressed && (now - lastMessageTime < this.NPC_CHAT_COOLDOWN_MS)) {
      console.log(`[Game] NPC ${npc.name} is on cooldown, skipping chat response`);
      return;
    }

    try {
      const message = await this.ai.generateChat(npc, this, isAddressed);

      if (message && message !== 'SILENCE' && this.state === 'DAY_DISCUSS') {
        // Update cooldown timestamp
        this.npcChatCooldowns[npc.id] = Date.now();

        const chatMsg = {
          senderId: npc.id,
          senderName: npc.name,
          message: message,
          isVampireChat: false,
          timestamp: Date.now()
        };
        this.gameChat.push(chatMsg);
        io.to(this.code).emit('chat_update', this.gameChat);

        // Mark that this NPC has responded since the last non-NPC message
        if (this.npcRespondedSinceLastMessage) {
          this.npcRespondedSinceLastMessage.add(npc.id);
        }

        // Generate TTS audio and send to host only
        const ttsCtrl = getTTSController(this.settings.ttsProvider);
        if (this.settings.enableTTS && ttsCtrl) {
          const provider = this.settings.ttsProvider || 'google';
          console.log(`[Game] TTS enabled (${provider}), synthesizing for ${npc.name}...`);
          // Build options for ElevenLabs (voiceId from NPC, modelId from settings, gender for voice matching)
          const ttsOptions = {
            voiceId: npc.elevenlabsVoiceId || null,
            modelId: this.settings.elevenlabsModel || null,
            gender: npc.gender || null
          };
          ttsCtrl.synthesizeSpeech(message, npc.id, this.settings.npcNationality || 'english', ttsOptions)
            .then(audioBase64 => {
              if (audioBase64) {
                const hostPlayer = this.players.find(p => p.id === this.host);
                if (hostPlayer && hostPlayer.socketId) {
                  io.to(hostPlayer.socketId).emit('tts_audio', {
                    audio: audioBase64,
                    senderName: npc.name,
                    senderId: npc.id
                  });
                  console.log(`[Game] Sent TTS audio to host for ${npc.name}`);
                }
              }
            })
            .catch(err => console.error('[Game] TTS synthesis error:', err));
        } else if (this.settings.enableTTS) {
          const provider = this.settings.ttsProvider || 'google';
          console.log(`[Game] TTS requested but ${provider} provider not available`);
        }
      }
    } catch (err) {
      console.error(`[Game] Error in AI chat for ${npc.name}:`, err);
    }
  }

  // Trigger NPC responses when a new non-NPC message arrives
  onNewChatMessage(senderId, messageContent) {
    if (!this.ai || this.state !== 'DAY_DISCUSS') return;

    const sender = this.players.find(p => p.id === senderId);
    if (!sender || sender.isNPC) return; // Only trigger on non-NPC messages

    // Reset the responded set since a new non-NPC message arrived
    this.npcRespondedSinceLastMessage = new Set();

    // Get all alive NPCs
    const npcPlayers = this.players.filter(p => p.isNPC && p.alive);
    if (npcPlayers.length === 0) return;

    // Determine which NPCs are addressed directly
    const mentionedNpcs = [];
    const otherNpcs = [];

    // Normalize message for case-insensitive check
    const lowerMsg = (messageContent || "").toLowerCase();

    npcPlayers.forEach(npc => {
      if (lowerMsg.includes(npc.name.toLowerCase())) {
        mentionedNpcs.push(npc);
      } else {
        otherNpcs.push(npc);
      }
    });

    // 1. Addressed NPCs respond almost immediately
    mentionedNpcs.forEach((npc, index) => {
      const delay = (index + 1) * (Math.random() * 1000 + 500);
      setTimeout(async () => {
        if (this.state !== 'DAY_DISCUSS' || !npc.alive) return;
        await this.triggerNPCChatResponse(npc, true); // true = addressed
      }, delay);
    });

    // 2. Others respond with lower probability (e.g. 20%) unless they have info
    // We trigger them, but with isAddressed=false, AI will decide to be SILENT mostly.
    const numResponders = Math.ceil(otherNpcs.length * 0.3); // Let ~30% of others *consider* responding
    const shuffledOthers = otherNpcs.sort(() => Math.random() - 0.5).slice(0, numResponders);

    shuffledOthers.forEach((npc, index) => {
      const delay = (mentionedNpcs.length * 1000) + (index + 1) * (Math.random() * 2000 + 1500);
      setTimeout(async () => {
        if (this.state !== 'DAY_DISCUSS' || !npc.alive) return;
        // Don't respond if handled above (though arrays are disjoint here)
        await this.triggerNPCChatResponse(npc, false);
      }, delay);
    });
  }

  // Handle NPC Jailor interrogation
  async startNPCJailorInterrogation(jailor, prisoner) {
    if (!this.ai || this.state !== 'NIGHT') return;

    console.log(`[Game] Starting NPC Jailor interrogation: ${jailor.name} -> ${prisoner.name}`);

    // Send first interrogation message after a delay
    setTimeout(async () => {
      if (this.state !== 'NIGHT' || !this.jailedPlayerId) return;

      try {
        const message = await this.ai.generateJailorMessage(jailor, this, this.jailChat, prisoner.name);
        if (message && this.state === 'NIGHT' && this.jailedPlayerId) {
          const chatMsg = {
            sender: 'Jailor',
            message: message.substring(0, 200),
            timestamp: Date.now()
          };
          this.jailChat.push(chatMsg);

          // Send to both parties
          if (jailor.socketId) {
            io.to(jailor.socketId).emit('jail_chat_update', this.jailChat);
          }
          if (prisoner.socketId) {
            io.to(prisoner.socketId).emit('jail_chat_update', this.jailChat);
          }

          // If prisoner is also an NPC, they should respond
          if (prisoner.isNPC && prisoner.alive) {
            this.triggerNPCPrisonerResponse(jailor, prisoner);
          }
        }
      } catch (err) {
        console.error('[Game] NPC Jailor interrogation error:', err);
      }
    }, Math.random() * 2000 + 2000); // 2-4 seconds for first message

    // Schedule execution decision near end of night
    const nightTime = this.settings.nightTime || 25;
    const decisionDelay = Math.max((nightTime - 5) * 1000, 10000); // 5 seconds before night ends, minimum 10 seconds

    setTimeout(async () => {
      if (this.state !== 'NIGHT' || !this.jailedPlayerId || this.jailorId !== jailor.id) return;

      try {
        const decision = await this.ai.generateExecuteDecision(jailor, this, this.jailChat, prisoner.name);
        console.log(`[Game] NPC Jailor ${jailor.name} decision:`, decision);

        if (decision.execute) {
          // Submit execute action
          this.nightActions[jailor.id] = { type: 'EXECUTE', actorId: jailor.id, targetId: this.jailedPlayerId };

          // Notify prisoner
          if (prisoner.socketId) {
            io.to(prisoner.socketId).emit('private_message', '☠️ The Jailor has decided to execute you!');
          }

          // Send final message
          const finalMsg = {
            sender: 'Jailor',
            message: `Your time has come. ${decision.reason || 'Justice will be served.'}`,
            timestamp: Date.now()
          };
          this.jailChat.push(finalMsg);

          if (jailor.socketId) {
            io.to(jailor.socketId).emit('jail_chat_update', this.jailChat);
          }
          if (prisoner.socketId) {
            io.to(prisoner.socketId).emit('jail_chat_update', this.jailChat);
          }
        } else {
          // Spare the prisoner
          const spareMsg = {
            sender: 'Jailor',
            message: `I'll let you go... for now. ${decision.reason || 'Stay out of trouble.'}`,
            timestamp: Date.now()
          };
          this.jailChat.push(spareMsg);

          if (jailor.socketId) {
            io.to(jailor.socketId).emit('jail_chat_update', this.jailChat);
          }
          if (prisoner.socketId) {
            io.to(prisoner.socketId).emit('jail_chat_update', this.jailChat);
          }
        }
      } catch (err) {
        console.error('[Game] NPC Jailor execution decision error:', err);
      }
    }, decisionDelay);
  }

  // Trigger NPC prisoner to respond to jailor
  async triggerNPCPrisonerResponse(jailor, prisoner) {
    if (!this.ai || this.state !== 'NIGHT' || !this.jailedPlayerId) return;

    setTimeout(async () => {
      if (this.state !== 'NIGHT' || !this.jailedPlayerId) return;

      try {
        const message = await this.ai.generateJailResponse(prisoner, this, this.jailChat, jailor.name);
        if (message && this.state === 'NIGHT' && this.jailedPlayerId) {
          const chatMsg = {
            sender: 'Prisoner',
            message: message.substring(0, 200),
            timestamp: Date.now()
          };
          this.jailChat.push(chatMsg);

          if (jailor.socketId) {
            io.to(jailor.socketId).emit('jail_chat_update', this.jailChat);
          }
          if (prisoner.socketId) {
            io.to(prisoner.socketId).emit('jail_chat_update', this.jailChat);
          }

          // Jailor NPC responds back (continue conversation)
          if (jailor.isNPC && jailor.alive && this.jailChat.length < 8) {
            setTimeout(async () => {
              if (this.state !== 'NIGHT' || !this.jailedPlayerId) return;

              const jailorReply = await this.ai.generateJailorMessage(jailor, this, this.jailChat, prisoner.name);
              if (jailorReply && this.state === 'NIGHT' && this.jailedPlayerId) {
                const replyMsg = {
                  sender: 'Jailor',
                  message: jailorReply.substring(0, 200),
                  timestamp: Date.now()
                };
                this.jailChat.push(replyMsg);

                if (jailor.socketId) {
                  io.to(jailor.socketId).emit('jail_chat_update', this.jailChat);
                }
                if (prisoner.socketId) {
                  io.to(prisoner.socketId).emit('jail_chat_update', this.jailChat);
                }

                // Continue if prisoner is NPC
                if (prisoner.isNPC && prisoner.alive && this.jailChat.length < 8) {
                  this.triggerNPCPrisonerResponse(jailor, prisoner);
                }
              }
            }, Math.random() * 2000 + 1500);
          }
        }
      } catch (err) {
        console.error('[Game] NPC Prisoner response error:', err);
      }
    }, Math.random() * 2000 + 1000);
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

  async addNPC() {
    const id = 'npc_' + Math.random().toString(36).substr(2, 9);
    let name = generateNPCName();
    let personality = null;
    let talkingStyle = null;
    let gender = null;
    let background = null;

    // Try to get AI generated profile
    if (this.ai) {
      const existingNames = this.players.map(p => p.name);
      const profile = await this.ai.generateNPCProfile(existingNames);
      if (profile) {
        name = profile.name;
        personality = profile.personality;
        talkingStyle = profile.talkingStyle;
        gender = profile.gender || null;
        background = profile.background || null;
      }
    }

    const npcPlayer = {
      id, name, socketId: null,
      role: null, alignment: null,
      alive: true, isTurned: false, connected: true,
      isNPC: true,
      personality,
      talkingStyle,
      gender,
      background
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
      'Doctor': 'good',
      'Citizen': 'good',
      'Jailor': 'good',
      'Vampire': 'evil',
      'Vampire Framer': 'evil',
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
      for (let i = 0; i < (config.Doctor || 0); i++) {
        pool.push({ role: 'Doctor', align: roleAlignments['Doctor'] });
      }
      for (let i = 0; i < (config.Jailor || 0); i++) {
        pool.push({ role: 'Jailor', align: roleAlignments['Jailor'] });
      }
      for (let i = 0; i < (config.Vampire || 0); i++) {
        pool.push({ role: 'Vampire', align: roleAlignments['Vampire'] });
      }
      for (let i = 0; i < (config['Vampire Framer'] || 0); i++) {
        pool.push({ role: 'Vampire Framer', align: roleAlignments['Vampire Framer'] });
      }
      for (let i = 0; i < (config.Jester || 0); i++) {
        pool.push({ role: 'Jester', align: roleAlignments['Jester'] });
      }

      // Fill remaining slots with Citizens
      while (pool.length < total) {
        pool.push({ role: 'Citizen', align: roleAlignments['Citizen'] });
      }

      // If we have more roles than players, smart exclusion to ensure game balance
      if (pool.length > total) {
        const excessCount = pool.length - total;

        // Separate roles by alignment
        const evilRoles = pool.filter(r => r.align === 'evil');
        const goodRoles = pool.filter(r => r.align === 'good');
        const neutralRoles = pool.filter(r => r.align === 'neutral');

        // Calculate requirements:
        // 1. At least 1 vampire (evil) must remain
        // 2. Good players must be majority (more than half)
        const minEvil = 1;
        const minGood = Math.floor(total / 2) + 1; // Majority requirement

        let rolesToExclude = [];

        // First, calculate how many of each type we can afford to remove
        let maxEvilToRemove = Math.max(0, evilRoles.length - minEvil);
        let maxGoodToRemove = Math.max(0, goodRoles.length - minGood);
        let maxNeutralToRemove = neutralRoles.length; // Can remove all neutral if needed

        // Prioritize removing excess roles while maintaining balance
        // Strategy: Try to maintain good majority, so prefer removing evil/neutral over good
        let remaining = excessCount;

        // 1. Remove excess evil roles (beyond the minimum 1)
        const evilToRemove = Math.min(remaining, maxEvilToRemove);
        rolesToExclude.push(...shuffle(evilRoles).slice(0, evilToRemove));
        remaining -= evilToRemove;

        // 2. Remove neutral roles
        if (remaining > 0) {
          const neutralToRemove = Math.min(remaining, maxNeutralToRemove);
          rolesToExclude.push(...shuffle(neutralRoles).slice(0, neutralToRemove));
          remaining -= neutralToRemove;
        }

        // 3. Remove excess good roles if still needed (maintaining majority)
        if (remaining > 0) {
          const goodToRemove = Math.min(remaining, maxGoodToRemove);
          rolesToExclude.push(...shuffle(goodRoles).slice(0, goodToRemove));
          remaining -= goodToRemove;
        }

        // 4. If we still have excess, we have to remove more (game might be unbalanced)
        // This happens when user configured an impossible setup
        if (remaining > 0) {
          const remainingPool = pool.filter(r => !rolesToExclude.includes(r));
          const additionalToRemove = shuffle(remainingPool).slice(0, remaining);
          rolesToExclude.push(...additionalToRemove);
        }

        // Remove the excluded roles from pool
        pool = pool.filter(r => !rolesToExclude.includes(r));

        console.log(`[Game] Smart role exclusion: removed ${excessCount} roles while maintaining game balance`);
      }
    } else {
      // Default calculation based on percentages
      const investCount = Math.max(1, Math.floor(total * 0.1));
      const lookoutCount = Math.max(1, Math.floor(total * 0.1));
      const doctorCount = Math.max(1, Math.floor(total * 0.1)); // Add 1 doctor roughly 10%
      const jailorCount = total >= 6 ? 1 : 0; // Add Jailor for 6+ players
      const vampCount = Math.max(1, Math.floor(total * 0.15)); // Slightly more vamps
      const jesterCount = 1;

      for (let i = 0; i < investCount; i++) pool.push({ role: 'Investigator', align: 'good' });
      for (let i = 0; i < lookoutCount; i++) pool.push({ role: 'Lookout', align: 'good' });
      for (let i = 0; i < doctorCount; i++) pool.push({ role: 'Doctor', align: 'good' });
      for (let i = 0; i < jailorCount; i++) pool.push({ role: 'Jailor', align: 'good' });
      for (let i = 0; i < vampCount; i++) pool.push({ role: 'Vampire', align: 'evil' });
      for (let i = 0; i < jesterCount; i++) pool.push({ role: 'Jester', align: 'neutral' });

      while (pool.length < total) pool.push({ role: 'Citizen', align: 'good' });
    }

    pool = shuffle(pool);

    this.players.forEach((p, i) => {
      p.role = pool[i].role;
      p.alignment = pool[i].align;
      if (p.role === 'Doctor') {
        p.healsRemaining = 3;
      } else {
        delete p.healsRemaining;
      }
    });

    // Check NPC allowed roles setting and reassign disallowed roles
    const npcAllowedRoles = this.settings.npcAllowedRoles || {};
    const allRolesAllowed = Object.keys(npcAllowedRoles).length === 0 ||
      Object.values(npcAllowedRoles).every(v => v !== false);

    if (!allRolesAllowed) {
      const npcs = this.players.filter(p => p.isNPC);
      const humans = this.players.filter(p => !p.isNPC);

      for (const npc of npcs) {
        // Check if NPC's role is disallowed
        if (npcAllowedRoles[npc.role] === false) {
          // Try to swap with a human who has an allowed role
          let swapped = false;
          for (const human of humans) {
            // Check if human's role is allowed for NPCs
            if (npcAllowedRoles[human.role] !== false) {
              // Swap roles
              const tempRole = npc.role;
              const tempAlign = npc.alignment;
              const tempHeals = npc.healsRemaining;

              npc.role = human.role;
              npc.alignment = human.alignment;
              npc.healsRemaining = human.healsRemaining;

              human.role = tempRole;
              human.alignment = tempAlign;
              human.healsRemaining = tempHeals;

              // Handle Doctor heals
              if (npc.role === 'Doctor') {
                npc.healsRemaining = 3;
              } else {
                delete npc.healsRemaining;
              }
              if (human.role === 'Doctor') {
                human.healsRemaining = 3;
              } else {
                delete human.healsRemaining;
              }

              swapped = true;
              break;
            }
          }

          // If no swap possible, assign NPC to Citizen (fallback)
          if (!swapped) {
            npc.role = 'Citizen';
            npc.alignment = roleAlignments['Citizen'];
            delete npc.healsRemaining;
          }
        }
      }
    }

    // Assign fake roles to Evil NPCs
    const goodRoles = ['Citizen', 'Doctor', 'Investigator', 'Lookout'];
    this.players.forEach(p => {
      if (p.isNPC && (p.alignment === 'evil' || p.role === 'Jester')) {
        // Pick a random good role to pretend to be
        const fakeRole = goodRoles[Math.floor(Math.random() * goodRoles.length)];
        p.fakeRole = fakeRole;
        console.log(`[Game] Assigned fake role ${fakeRole} to evil NPC ${p.name} (${p.role})`);
      }
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
    // Reset jail state for new night
    this.jailedPlayerId = null;
    this.jailorId = null;
    this.jailChat = [];
    // Reset framed players for new night
    this.framedPlayers = {};
    // Clear game chat for new night (vampire chat starts fresh)
    this.gameChat = [];
    this.broadcastUpdate();
    this.startTimer(this.settings.nightTime, () => this.resolveNight());
    this.triggerAIActions(); // Trigger AI for night
  }

  resolveNight() {
    let visits = {};
    let investigationResults = {};
    let doctorHeals = [];

    // 1. Process Visits
    Object.values(this.nightActions).forEach(action => {
      const { actorId, targetId } = action;
      if (!visits[targetId]) visits[targetId] = [];
      const actor = this.players.find(p => p.id === actorId);
      if (actor) visits[targetId].push(actor.name);

      // Track doctor heals
      if (action.type === 'HEAL') {
        doctorHeals.push({ actorId, targetId });
      }
    });

    // 2. Consume Doctor Heals
    // Doctors lose a heal attempts even if they don't value save anyone, usually? 
    // The prompt says "3 heals that they can use". We will decrement for every action submitted.
    doctorHeals.forEach(({ actorId }) => {
      const doctor = this.players.find(p => p.id === actorId);
      if (doctor && doctor.role === 'Doctor' && doctor.healsRemaining > 0) {
        doctor.healsRemaining--;
      }
    });

    // 3. Vampire Logic (Every other night, starting night 2)
    const canTurn = (this.round % 2 === 0);
    let turnedPlayer = null;
    if (canTurn) {
      const vampActions = Object.values(this.nightActions).filter(a => a.type === 'BITE');
      const aliveVampires = this.players.filter(p => (p.role === 'Vampire' || p.role === 'Vampire Framer') && p.alive);

      if (vampActions.length > 0) {
        // Count votes for each target
        const voteCount = {};
        vampActions.forEach(action => {
          voteCount[action.targetId] = (voteCount[action.targetId] || 0) + 1;
        });

        // Find the maximum number of votes
        let maxVotes = 0;
        for (const count of Object.values(voteCount)) {
          if (count > maxVotes) maxVotes = count;
        }

        // Find all targets with the maximum votes
        const topTargets = Object.keys(voteCount).filter(targetId => voteCount[targetId] === maxVotes);

        // Pick one target (randomly if tied)
        let potentialTargetId = null;
        if (topTargets.length > 0) {
          potentialTargetId = topTargets[Math.floor(Math.random() * topTargets.length)];

          // If there was a tie, notify vampires
          if (topTargets.length > 1) {
            aliveVampires.forEach(vamp => {
              if (vamp.socketId) {
                io.to(vamp.socketId).emit('private_message', '🧛 The vampire vote was tied! A target was picked randomly among the top votes.');
              }
            });
          }
        }

        if (potentialTargetId) {
          const target = this.players.find(p => p.id === potentialTargetId);
          if (target && target.alive && target.role !== 'Vampire' && target.role !== 'Vampire Framer') {
            // Check if target is jailed - jailed players are protected from vampire bites
            const isJailed = this.jailedPlayerId === potentialTargetId;
            const isHealed = doctorHeals.some(h => h.targetId === potentialTargetId);

            if (isJailed) {
              // Jailed players are protected from vampire bites
              this.logs.push(`[Night ${this.round}] The vampires tried to attack, but their target was unreachable!`);
              aliveVampires.forEach(vamp => {
                if (vamp.socketId) io.to(vamp.socketId).emit('private_message', `🧛 Your target was protected by the Jailor!`);
              });
            } else if (isHealed) {
              this.logs.push(`[Night ${this.round}] The vampires tried to attack, but their target was saved by a doctor!`);
              aliveVampires.forEach(vamp => {
                if (vamp.socketId) io.to(vamp.socketId).emit('private_message', `🧛 Your target was saved by a Doctor!`);
              });
              doctorHeals.filter(h => h.targetId === potentialTargetId).forEach(h => {
                const doc = this.players.find(p => p.id === h.actorId);
                if (doc && doc.socketId) {
                  io.to(doc.socketId).emit('private_message', `💉 You successfully saved your target from a vampire attack!`);
                }
              });
            } else {
              target.role = 'Vampire';
              target.alignment = 'evil';
              target.isTurned = true;
              turnedPlayer = target;
              this.logs.push(`[Night ${this.round}] A dark ritual took place... someone's nature has changed.`);
            }
          }
        }
      }
    }

    // 4. Vampire Framer - Process FRAME actions
    Object.keys(this.nightActions).forEach(actionKey => {
      const action = this.nightActions[actionKey];
      if (action.type === 'FRAME') {
        const actor = this.players.find(p => p.id === action.actorId);
        if (actor && actor.role === 'Vampire Framer' && actor.alive) {
          this.framedPlayers[action.targetId] = true;
          if (actor.socketId) {
            const target = this.players.find(p => p.id === action.targetId);
            io.to(actor.socketId).emit('private_message', `🎭 You have framed ${target?.name || 'your target'}. They will appear as a Vampire to investigators tonight.`);
          }
        }
      }
    });

    // 5. Investigator
    Object.keys(this.nightActions).forEach(actorId => {
      const action = this.nightActions[actorId];
      if (action.type === 'INVESTIGATE') {
        const target = this.players.find(p => p.id === action.targetId);
        // Check if target is framed - framed players appear as Vampire
        const isFramed = this.framedPlayers[action.targetId];
        if (isFramed) {
          investigationResults[actorId] = 'Target is a Vampire';
        } else {
          investigationResults[actorId] = target ? `Target is a ${target.role}` : 'Unknown';
        }
      }
    });

    // 6. Lookout
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

    // Notify turned player and send updated role info
    if (turnedPlayer && turnedPlayer.socketId) {
      // Send private notification about being turned
      io.to(turnedPlayer.socketId).emit('private_message', '🧛 You have been turned into a Vampire! You are now part of the vampire faction.');

      // Send updated role info immediately
      io.to(turnedPlayer.socketId).emit('role_info', {
        role: turnedPlayer.role,
        alignment: turnedPlayer.alignment
      });

      // Get list of other vampires for the newly turned player
      const otherVampires = this.players
        .filter(p => p.role === 'Vampire' && p.alive && p.id !== turnedPlayer.id)
        .map(p => p.name);
      if (otherVampires.length > 0) {
        io.to(turnedPlayer.socketId).emit('private_message', `🧛 Your fellow vampires are: ${otherVampires.join(', ')}`);
      }
    }

    // 6. Jailor Execution Logic
    if (this.jailedPlayerId && this.jailorId) {
      const jailor = this.players.find(p => p.id === this.jailorId);
      const prisoner = this.players.find(p => p.id === this.jailedPlayerId);
      const jailAction = this.nightActions[this.jailorId];

      if (jailAction && jailAction.type === 'EXECUTE' && prisoner && prisoner.alive) {
        // Execute the prisoner
        prisoner.alive = false;
        this.logs.push(`[Night ${this.round}] ${prisoner.name} was executed by the Jailor.`);

        // If prisoner was innocent (good alignment), jailor will die
        if (prisoner.alignment === 'good') {
          this.jailorPendingDeath = true;
          if (jailor && jailor.socketId) {
            io.to(jailor.socketId).emit('private_message', '⚠️ You executed an innocent person! Guilt consumes you...');
          }
        } else {
          if (jailor && jailor.socketId) {
            io.to(jailor.socketId).emit('private_message', '🔒 Justice served. The prisoner was guilty.');
          }
        }
      } else {
        // Prisoner was not executed, just released
        if (prisoner && prisoner.socketId) {
          io.to(prisoner.socketId).emit('private_message', '🔓 Dawn breaks. The Jailor releases you from jail.');
        }
      }
    }

    this.checkWinCondition();
    if (this.state !== 'GAME_OVER') this.startDayDiscuss();
  }

  startDayDiscuss() {
    this.state = 'DAY_DISCUSS';

    // Jailor dies if they executed an innocent
    if (this.jailorPendingDeath) {
      const jailor = this.players.find(p => p.id === this.jailorId);
      if (jailor && jailor.alive) {
        jailor.alive = false;
        this.logs.push(`[Day ${this.round}] ${jailor.name} was consumed by guilt and died!`);
      }
      this.jailorPendingDeath = false;
    }

    // Clear jail state
    this.jailedPlayerId = null;
    this.jailorId = null;
    this.jailChat = [];

    // Clear game chat for new day
    this.gameChat = [];

    this.broadcastUpdate();
    this.startTimer(this.settings.discussionTime, () => this.startDayVote());
    this.triggerAIActions(); // Trigger AI for discussion
  }

  startDayVote() {
    this.state = 'DAY_VOTE';
    this.votes = {};
    this.broadcastUpdate();
    this.startTimer(this.settings.votingTime || 15, () => this.resolveVoting());
    this.triggerAIActions(); // Trigger AI for voting
  }

  resolveVoting() {
    const counts = {};
    Object.values(this.votes).forEach(targetId => {
      counts[targetId] = (counts[targetId] || 0) + 1;
    });

    let lynchedId = null;
    const livingCount = this.players.filter(p => p.alive).length;

    // Majority >= 50%
    for (const [targetId, count] of Object.entries(counts)) {
      if (count >= livingCount / 2) {
        lynchedId = targetId;
        break;
      }
    }

    if (lynchedId) {
      const victim = this.players.find(p => p.id === lynchedId);
      victim.alive = false;
      this.logs.push(`[Day ${this.round}] ${victim.name} was lynched!`);

      if (victim.role === 'Jester') {
        this.state = 'GAME_OVER';
        this.winner = 'Jester';
        this.logs.push(`[Day ${this.round}] The Jester was lynched! Jester Wins!`);
        this.broadcastUpdate();
        return;
      }

      if (this.settings.revealRole) {
        this.logs.push(`[Day ${this.round}] ${victim.name} was a ${victim.role}`);
      }
    } else {
      this.logs.push(`[Day ${this.round}] No one received enough votes.`);
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
      winner: this.winner,
      logs: this.logs,
      chatEnabled: this.settings.chatEnabled !== false,
      enableSTT: this.settings.enableSTT || false,
      voiceInputMode: this.settings.voiceInputMode || 'push-to-talk',
      gameChat: this.gameChat
    };

    // Calculate vampire info for night phase
    const aliveVampires = this.players.filter(p => (p.role === 'Vampire' || p.role === 'Vampire Framer') && p.alive);
    const vampireCount = aliveVampires.length;
    const canTurn = (this.round % 2 === 0);

    // Send personalized state to each player
    this.players.forEach(player => {
      const isVampire = player.role === 'Vampire' || player.role === 'Vampire Framer';
      const playerState = {
        ...baseState,
        // Send heal count to doctor
        healsRemaining: player.role === 'Doctor' ? player.healsRemaining : undefined,
        players: this.players.map(p => ({
          id: p.id,
          name: p.name,
          alive: p.alive,
          votes: this.countVotesFor(p.id),
          isNPC: p.isNPC || false,
          role: (this.state === 'GAME_OVER') ? p.role : undefined,
          alignment: (this.state === 'GAME_OVER') ? p.alignment : undefined,
          // Always show vampire status to other vampires (not just during night)
          isVampire: isVampire ? (p.role === 'Vampire' || p.role === 'Vampire Framer') : undefined,
          // Show the actual vampire role to teammates (Vampire or Vampire Framer)
          vampireRole: isVampire && (p.role === 'Vampire' || p.role === 'Vampire Framer') ? p.role : undefined,
          // Show vampire turning votes to vampires during night
          vampireVotes: (isVampire && this.state === 'NIGHT' && canTurn) ? this.countVampireVotesFor(p.id) : undefined
        })),
        // Include vampire coordination info for vampires during night
        vampireInfo: (isVampire && this.state === 'NIGHT' && canTurn) ? {
          totalVampires: vampireCount,
          requiredVotes: 1,
          needsVoting: vampireCount > 1
        } : undefined,
        // Include jail info for Jailor and jailed player
        jailInfo: (this.state === 'NIGHT' && (player.id === this.jailorId || player.id === this.jailedPlayerId)) ? {
          isJailor: player.id === this.jailorId,
          isJailed: player.id === this.jailedPlayerId,
          prisonerName: player.id === this.jailorId ? this.players.find(p => p.id === this.jailedPlayerId)?.name : null,
          jailorName: player.id === this.jailedPlayerId ? this.players.find(p => p.id === this.jailorId)?.name : null,
          jailChat: this.jailChat
        } : undefined
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

  countVampireVotesFor(pid) {
    if (this.state !== 'NIGHT') return 0;
    return Object.values(this.nightActions)
      .filter(a => a.type === 'BITE' && a.targetId === pid)
      .length;
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

  // --- HOST: UPDATE SETTINGS ---
  socket.on('update_settings', ({ code, settings }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id && game.state === 'LOBBY') {
      // Merge new settings with existing settings
      game.settings = { ...game.settings, ...settings };

      // Re-initialize AI controller if enableAI or npcNationality setting changed
      if (settings.enableAI !== undefined || settings.npcNationality !== undefined) {
        if ((settings.enableAI ?? game.settings.enableAI) && GEMINI_API_KEY) {
          game.ai = new AIController(GEMINI_API_KEY, game.settings.npcNationality || 'english');
        } else if (settings.enableAI === false) {
          game.ai = null;
        }
      }

      // Re-initialize TTS controller if enableTTS or ttsProvider changed
      if (settings.enableTTS !== undefined || settings.ttsProvider !== undefined) {
        const shouldUseTTS = settings.enableTTS ?? game.settings.enableTTS;
        const provider = settings.ttsProvider || game.settings.ttsProvider;

        if (shouldUseTTS) {
          game.tts = getTTSController(provider);
        } else {
          game.tts = null;
        }
      }

      // Re-initialize STT controller if enableSTT changed
      if (settings.enableSTT !== undefined) {
        const shouldUseSTT = settings.enableSTT;
        if (shouldUseSTT) {
          game.stt = googleSTTController;
        } else {
          game.stt = null;
        }
      }

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
      // Handle clearing/uncasting of action (but not EXECUTE which intentionally has null targetId)
      if (action.clear || (action.targetId === null && action.type !== 'EXECUTE')) {
        // Check if we're clearing a BITE action - notify other vampires
        if (action.type === 'BITE' && game.nightActions[player.id]) {
          const aliveVampires = game.players.filter(p => (p.role === 'Vampire' || p.role === 'Vampire Framer') && p.alive);
          if (aliveVampires.length > 1) {
            aliveVampires.forEach(vamp => {
              if (vamp.socketId && vamp.id !== player.id) {
                io.to(vamp.socketId).emit('private_message', `🧛 ${player.name} cancelled their vote`);
              }
            });
          }
        }
        // Check if we're clearing a FRAME action - Vampire Framer can have separate FRAME action
        if (action.type === 'FRAME' && game.nightActions[player.id + '_frame']) {
          delete game.nightActions[player.id + '_frame'];
          game.broadcastUpdate();
          return;
        }
        delete game.nightActions[player.id];
        game.broadcastUpdate();
        return;
      }

      // Validate BITE action - vampires can't target other vampires
      if (action.type === 'BITE') {
        const target = game.players.find(p => p.id === action.targetId);
        if (target && (target.role === 'Vampire' || target.role === 'Vampire Framer')) {
          socket.emit('private_message', 'Cannot turn a fellow vampire!');
          return;
        }

        // Notify all vampires about this vote (only if there are 2+ vampires)
        const aliveVampires = game.players.filter(p => (p.role === 'Vampire' || p.role === 'Vampire Framer') && p.alive);
        if (aliveVampires.length > 1 && target) {
          aliveVampires.forEach(vamp => {
            if (vamp.socketId && vamp.id !== player.id) {
              io.to(vamp.socketId).emit('private_message', `🧛 ${player.name} voted to turn ${target.name}`);
            }
          });
        }
      }

      // Validate HEAL action
      if (action.type === 'HEAL') {
        if (player.role !== 'Doctor') return;
        if ((player.healsRemaining || 0) <= 0) {
          socket.emit('private_message', 'You have no heals remaining!');
          return;
        }
      }

      // Validate JAIL action - only Jailor can jail
      if (action.type === 'JAIL') {
        if (player.role !== 'Jailor') return;
        if (!player.alive) return;

        const target = game.players.find(p => p.id === action.targetId);
        if (!target || !target.alive) {
          socket.emit('private_message', 'Invalid target for jail.');
          return;
        }
        if (target.id === player.id) {
          socket.emit('private_message', 'You cannot jail yourself!');
          return;
        }

        // Set jail state
        game.jailedPlayerId = action.targetId;
        game.jailorId = player.id;
        game.jailChat = [];

        // Clear any existing action the jailed player may have submitted
        const existingAction = game.nightActions[action.targetId];
        if (existingAction) {
          // If jailed player was a vampire who voted, notify other vampires
          if (existingAction.type === 'BITE') {
            const aliveVampires = game.players.filter(p => p.role === 'Vampire' && p.alive && p.id !== target.id);
            aliveVampires.forEach(vamp => {
              if (vamp.socketId) {
                io.to(vamp.socketId).emit('private_message', `🧛 ${target.name}'s vote was cancelled (jailed)`);
              }
            });
          }
          delete game.nightActions[action.targetId];
        }

        // Notify both parties
        socket.emit('private_message', `\ud83d\udd12 You have jailed ${target.name}. You may now interrogate them.`);
        if (target.socketId) {
          io.to(target.socketId).emit('private_message', '\ud83d\udd12 You have been jailed! The Jailor wishes to speak with you. Your night action has been cancelled.');
        }

        game.broadcastUpdate();
        return;
      }

      // Validate EXECUTE action - only Jailor can execute their prisoner
      if (action.type === 'EXECUTE') {
        if (player.role !== 'Jailor') return;
        if (game.jailorId !== player.id) {
          socket.emit('private_message', 'You have no prisoner to execute.');
          return;
        }

        // Store the execute action
        game.nightActions[player.id] = { type: 'EXECUTE', actorId: player.id, targetId: game.jailedPlayerId };

        const prisoner = game.players.find(p => p.id === game.jailedPlayerId);
        socket.emit('private_message', `\u2620\ufe0f You have decided to execute ${prisoner?.name || 'the prisoner'}.`);
        if (prisoner && prisoner.socketId) {
          io.to(prisoner.socketId).emit('private_message', '\u2620\ufe0f The Jailor has decided to execute you!');
        }

        game.broadcastUpdate();
        return;
      }

      // Handle CANCEL_EXECUTE - Jailor can cancel their execution decision
      if (action.type === 'CANCEL_EXECUTE') {
        if (player.role !== 'Jailor') return;
        if (game.jailorId !== player.id) return;

        // Remove the execute action if it exists
        if (game.nightActions[player.id]?.type === 'EXECUTE') {
          delete game.nightActions[player.id];

          const prisoner = game.players.find(p => p.id === game.jailedPlayerId);
          socket.emit('private_message', `\u274c Execution cancelled. ${prisoner?.name || 'The prisoner'} will be released at dawn.`);
          if (prisoner && prisoner.socketId) {
            io.to(prisoner.socketId).emit('private_message', '\ud83d\ude0c The Jailor has decided to spare you.');
          }
        }
        return;
      }

      // Block jailed players from performing night actions
      if (game.jailedPlayerId === player.id) {
        socket.emit('private_message', '\ud83d\udd12 You are in jail and cannot perform your night action.');
        return;
      }

      // Validate FRAME action - only Vampire Framer can frame
      if (action.type === 'FRAME') {
        if (player.role !== 'Vampire Framer') return;
        if (!player.alive) return;

        const target = game.players.find(p => p.id === action.targetId);
        if (!target || !target.alive) {
          socket.emit('private_message', 'Invalid target for framing.');
          return;
        }
        if (target.role === 'Vampire' || target.role === 'Vampire Framer') {
          socket.emit('private_message', 'Cannot frame a fellow vampire!');
          return;
        }

        // Store FRAME action with special key so it doesn't conflict with BITE
        game.nightActions[player.id + '_frame'] = { ...action, actorId: player.id };
        game.broadcastUpdate();
        return;
      }

      game.nightActions[player.id] = { ...action, actorId: player.id };

      // Broadcast update to show vote counts for vampires
      if (action.type === 'BITE') {
        game.broadcastUpdate();
      }
    }
  });

  socket.on('day_vote', ({ code, targetId }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && game.state === 'DAY_VOTE' && player && player.alive) {
      // Handle unvoting when targetId is null
      if (targetId === null) {
        delete game.votes[player.id];
      } else {
        game.votes[player.id] = targetId;
      }
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
  // --- HOST: ADD NPC ---
  socket.on('add_npc', async ({ code }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id && game.state === 'LOBBY') {
      await game.addNPC();
      game.broadcastUpdate();
    }
  });

  // --- HOST: GET NPC DETAILS ---
  socket.on('get_npc_details', ({ code, targetId }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id) {
      const target = game.players.find(p => p.id === targetId && p.isNPC);
      if (target) {
        socket.emit('npc_details', {
          id: target.id,
          name: target.name,
          personality: target.personality || '',
          talkingStyle: target.talkingStyle || '',
          elevenlabsVoiceId: target.elevenlabsVoiceId || ''
        });
      }
    }
  });

  // --- HOST: UPDATE NPC DETAILS ---
  socket.on('update_npc', ({ code, targetId, name, personality, talkingStyle, elevenlabsVoiceId }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id && game.state === 'LOBBY') {
      const target = game.players.find(p => p.id === targetId && p.isNPC);
      if (target) {
        target.name = name.trim();
        target.personality = personality?.trim() || null;
        target.talkingStyle = talkingStyle?.trim() || null;
        target.elevenlabsVoiceId = elevenlabsVoiceId || null;
        game.broadcastUpdate();
      }
    }
  });

  // --- GET ELEVENLABS OPTIONS ---
  socket.on('get_elevenlabs_options', () => {
    socket.emit('elevenlabs_options', {
      models: ElevenLabsTTSController.getAvailableModels(),
      voices: ElevenLabsTTSController.getAvailableVoices()
    });
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
          isNPC: target.isNPC,
          alive: target.alive
        });
      }
    }
  });

  // --- HOST: CHANGE PLAYER ROLE ---
  socket.on('change_player_role', ({ code, targetId, newRole }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id) {
      const target = game.players.find(p => p.id === targetId);
      if (target) {
        // Role alignment mapping
        const roleAlignments = {
          'Investigator': 'good',
          'Lookout': 'good',
          'Doctor': 'good',
          'Citizen': 'good',
          'Jailor': 'good',
          'Vampire': 'evil',
          'Vampire Framer': 'evil',
          'Jester': 'neutral'
        };

        // Update the target's role
        target.role = newRole;
        target.alignment = roleAlignments[newRole] || 'good';

        if (target.role === 'Doctor') {
          target.healsRemaining = 3;
        } else {
          delete target.healsRemaining;
        }

        // Send updated role info to the target player
        if (target.socketId) {
          io.to(target.socketId).emit('role_info', {
            role: target.role,
            alignment: target.alignment
          });
          io.to(target.socketId).emit('private_message', `🎭 Your role has been changed to ${newRole}!`);
        }

        // Confirm to the host
        socket.emit('player_role_info', {
          playerId: target.id,
          name: target.name,
          role: target.role,
          alignment: target.alignment,
          isNPC: target.isNPC,
          alive: target.alive
        });

        // Log the change (only visible to host/server)
        console.log(`Host changed ${target.name}'s role to ${newRole}`);

        // Broadcast update to refresh vampire teammate visibility etc.
        game.broadcastUpdate();
      }
    }
  });

  // --- HOST: KILL/REVIVE PLAYER ---
  socket.on('set_player_alive_status', ({ code, targetId, alive }) => {
    const game = games[code];
    const player = game?.players.find(p => p.socketId === socket.id);
    if (game && player && game.host === player.id) {
      const target = game.players.find(p => p.id === targetId);
      if (target) {
        target.alive = alive;

        // Notify the player
        if (target.socketId) {
          const msg = alive
            ? "😇 You have been revived by the host!"
            : "💀 You have been killed by the host!";
          io.to(target.socketId).emit('private_message', msg);
        }

        // Update host modal view
        socket.emit('player_role_info', {
          playerId: target.id,
          name: target.name,
          role: target.role,
          alignment: target.alignment,
          isNPC: target.isNPC,
          alive: target.alive
        });

        // Log to game log
        const logMsg = alive
          ? `The host revived ${target.name}.`
          : `The host struck down ${target.name}.`;
        game.logs.push(logMsg);

        game.broadcastUpdate();
      }
    }
  });

  // --- JAIL CHAT ---
  socket.on('jail_chat_message', ({ code, message }) => {
    const game = games[code];
    if (!game || game.state !== 'NIGHT') return;

    const player = game.players.find(p => p.socketId === socket.id);
    if (!player) return;

    // Only Jailor or jailed player can send messages
    if (player.id !== game.jailorId && player.id !== game.jailedPlayerId) return;

    const isJailor = player.id === game.jailorId;
    const chatMessage = {
      sender: isJailor ? 'Jailor' : 'Prisoner',
      message: message.substring(0, 200), // Limit message length
      timestamp: Date.now()
    };

    game.jailChat.push(chatMessage);

    // Send to both parties
    const jailor = game.players.find(p => p.id === game.jailorId);
    const prisoner = game.players.find(p => p.id === game.jailedPlayerId);

    if (jailor && jailor.socketId) {
      io.to(jailor.socketId).emit('jail_chat_update', game.jailChat);
    }
    if (prisoner && prisoner.socketId) {
      io.to(prisoner.socketId).emit('jail_chat_update', game.jailChat);
    }

    // Trigger NPC response if the other party is an NPC
    if (game.ai) {
      const otherParty = isJailor ? prisoner : jailor;
      if (otherParty && otherParty.isNPC && otherParty.alive) {
        // Delay NPC response to feel natural
        setTimeout(async () => {
          if (game.state !== 'NIGHT' || !game.jailedPlayerId) return;

          try {
            let npcMessage;
            if (isJailor) {
              // Jailor sent message, prisoner NPC responds
              npcMessage = await game.ai.generateJailResponse(
                otherParty, game, game.jailChat, jailor.name
              );
            } else {
              // Prisoner sent message, jailor NPC responds
              npcMessage = await game.ai.generateJailorMessage(
                otherParty, game, game.jailChat, prisoner.name
              );
            }

            if (npcMessage && game.state === 'NIGHT' && game.jailedPlayerId) {
              const npcChatMessage = {
                sender: isJailor ? 'Prisoner' : 'Jailor',
                message: npcMessage.substring(0, 200),
                timestamp: Date.now()
              };
              game.jailChat.push(npcChatMessage);

              // Send updated chat to both parties
              if (jailor && jailor.socketId) {
                io.to(jailor.socketId).emit('jail_chat_update', game.jailChat);
              }
              if (prisoner && prisoner.socketId) {
                io.to(prisoner.socketId).emit('jail_chat_update', game.jailChat);
              }
            }
          } catch (err) {
            console.error('[Game] NPC jail chat error:', err);
          }
        }, Math.random() * 2000 + 1000); // 1-3 second delay
      }
    }
  });

  // --- GAME CHAT ---
  socket.on('chat_message', ({ code, message }) => {
    const game = games[code];
    if (!game) return;
    if (game.state === 'LOBBY' || game.state === 'GAME_OVER') return;
    // Chat still works when disabled - it's just hidden from players on the client side

    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || !player.alive) return;

    const isVampire = player.role === 'Vampire' || player.role === 'Vampire Framer';
    const isDayPhase = game.state === 'DAY_DISCUSS' || game.state === 'DAY_VOTE';
    const isNightPhase = game.state === 'NIGHT';

    // Night: only vampires can chat
    if (isNightPhase && !isVampire) return;

    const chatMessage = {
      senderId: player.id,
      senderName: player.name,
      message: message.substring(0, 300), // Limit message length
      isVampireChat: isNightPhase && isVampire,
      timestamp: Date.now()
    };

    game.gameChat.push(chatMessage);

    // Trigger NPC responses to this message (during day discussion)
    game.onNewChatMessage(player.id, message);

    // Day: broadcast to all players. Night: only to vampires
    if (isDayPhase) {
      game.players.forEach(p => {
        if (p.socketId) {
          io.to(p.socketId).emit('chat_update', game.gameChat);
        }
      });
    } else if (isNightPhase) {
      // Send to all vampires
      game.players.forEach(p => {
        const pIsVampire = p.role === 'Vampire' || p.role === 'Vampire Framer';
        if (pIsVampire && p.socketId) {
          io.to(p.socketId).emit('chat_update', game.gameChat);
        }
      });
    }
  });

  // --- VOICE CHAT (Speech-to-Text) ---
  socket.on('voice_audio_chunk', async ({ code, audioChunk }) => {
    const game = games[code];
    if (!game) return;

    // Only allow during DAY_DISCUSS phase
    if (game.state !== 'DAY_DISCUSS') return;
    // Voice chat still works when chat is disabled - it's just hidden from players on the client side

    const player = game.players.find(p => p.socketId === socket.id);
    if (!player || !player.alive) return;

    // Check if STT is enabled and available
    if (!game.stt || !game.stt.isAvailable()) {
      socket.emit('error', 'Voice chat is not available');
      return;
    }

    try {

      const transcript = await game.stt.recognizeStream(
        audioChunk,
        game.settings.npcNationality || 'english'
      );

      if (transcript && transcript.trim().length > 0) {
        const chatMessage = {
          senderId: player.id,
          senderName: player.name,
          message: transcript.substring(0, 300), // Limit message length
          isVampireChat: false,
          timestamp: Date.now(),
          isVoiceMessage: true // Flag to distinguish voice messages
        };

        game.gameChat.push(chatMessage);

        // Broadcast to all players
        io.to(code).emit('chat_update', game.gameChat);

        // Trigger NPC responses to this message
        // Trigger NPC responses to this message
        game.onNewChatMessage(player.id, transcript);



        console.log(`[STT] Voice message from ${player.name}: "${transcript}"`);
      } else {
        console.log(`[STT] No transcript received for ${player.name}`);
        // Silently fail - don't show an alert to the user
      }
    } catch (err) {
      console.error('[STT] Error processing voice input:', err);
      socket.emit('error', 'Failed to process voice input');
    }
  });

  // Check if STT is available
  socket.on('get_stt_available', () => {
    socket.emit('stt_available', googleSTTController.isAvailable());
  });
});

// Listen on 0.0.0.0 to accept connections from all network interfaces
// This allows other devices on the network to connect via your IP address
server.listen(3001, '0.0.0.0', () => {
  console.log(`Server running on port 3001 using ${protocol.toUpperCase()} (accessible from all interfaces)`);
});
