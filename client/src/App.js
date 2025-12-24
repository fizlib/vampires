import React, { useState, useEffect, useRef, useMemo } from 'react';
import io from 'socket.io-client';
import './App.css';

// Dynamically connect to the server using the current hostname
// This allows the app to work both on localhost and when accessed via IP address
const socket = io(`http://${window.location.hostname}:3001`);

// Random username generator
const generateRandomUsername = () => {
  const adjectives = ['Shadow', 'Dark', 'Blood', 'Night', 'Crimson', 'Silent', 'Mystic', 'Ancient', 'Pale', 'Eternal'];
  const nouns = ['Hunter', 'Walker', 'Stalker', 'Slayer', 'Seeker', 'Watcher', 'Phantom', 'Specter', 'Raven', 'Wolf'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
};

// Role descriptions
const ROLE_INFO = {
  Investigator: {
    alignment: 'Good',
    ability: 'Each night, investigate one player to learn if they are suspicious.',
    goal: 'Eliminate all vampires and survive.'
  },
  Lookout: {
    alignment: 'Good',
    ability: 'Each night, watch one player to see who visits them.',
    goal: 'Eliminate all vampires and survive.'
  },
  Doctor: {
    alignment: 'Good',
    ability: 'Each night, heal one player to save them from vampire attacks. You have 3 heals per game.',
    goal: 'Eliminate all vampires and survive.'
  },
  Citizen: {
    alignment: 'Good',
    ability: 'No special ability. Use your vote wisely during the day.',
    goal: 'Eliminate all vampires and survive.'
  },
  Vampire: {
    alignment: 'Evil',
    ability: 'Every other night, vote to turn a citizen. The target with the most votes is turned (ties are random)!',
    goal: 'Turn or eliminate all non-vampires.'
  },
  Jester: {
    alignment: 'Neutral',
    ability: 'No special night ability. Try to act suspicious!',
    goal: 'Get yourself voted out during the day to win.'
  }
};

// Pre-generate snowflake data outside component to prevent regeneration
const SNOWFLAKE_DATA = Array.from({ length: 50 }, (_, i) => ({
  id: i,
  left: `${Math.random() * 100}%`,
  animationDuration: `${5 + Math.random() * 10}s`,
  animationDelay: `${Math.random() * 5}s`,
  fontSize: `${0.5 + Math.random() * 1}rem`,
}));

// Snowfall component defined outside App to prevent re-creation
const Snowfall = React.memo(() => {
  return (
    <div className="snowfall">
      {SNOWFLAKE_DATA.map((flake) => (
        <div
          key={flake.id}
          className="snowflake"
          style={{
            left: flake.left,
            animationDuration: flake.animationDuration,
            animationDelay: flake.animationDelay,
            fontSize: flake.fontSize,
          }}
        >
          ❄
        </div>
      ))}
    </div>
  );
});

function App() {
  // Initialize state from localStorage where applicable
  const [view, setView] = useState(() => {
    const savedView = localStorage.getItem('vampire_view');
    // Don't persist ENTER_USERNAME - it's a transient state
    if (savedView === 'ENTER_USERNAME') return 'MENU';
    return savedView || 'MENU';
  });
  const [name, setName] = useState(() => localStorage.getItem('vampire_name') || '');
  const [code, setCode] = useState(() => localStorage.getItem('vampire_code') || '');
  const [pendingCode, setPendingCode] = useState(''); // Code waiting for username
  const [isCreating, setIsCreating] = useState(false); // Track if we're creating vs joining
  const [gameState, setGameState] = useState(null);
  const [myRole, setMyRole] = useState(() => {
    const savedRole = localStorage.getItem('vampire_role');
    return savedRole ? JSON.parse(savedRole) : null;
  });
  const [myId, setMyId] = useState(() => localStorage.getItem('vampire_id') || null);
  const [privateMsg, setPrivateMsg] = useState(() => localStorage.getItem('vampire_private_msg') || '');
  const [timer, setTimer] = useState(0);
  const [selectedPlayerRole, setSelectedPlayerRole] = useState(null); // For host role viewing modal
  const [nightTarget, setNightTarget] = useState(null); // Track who we targeted at night
  const [voteTarget, setVoteTarget] = useState(null); // Track who we voted for
  const [roleRevealed, setRoleRevealed] = useState(false); // Track if role is revealed
  const [shareLinkCopied, setShareLinkCopied] = useState(false); // Track if share link was copied
  const [showShareModal, setShowShareModal] = useState(false); // Track if share modal is open
  const prevGameState = useRef(null); // Track previous game state for transitions

  // Settings - also persist these
  const [settings, setSettings] = useState(() => {
    const savedSettings = localStorage.getItem('vampire_settings');
    return savedSettings ? JSON.parse(savedSettings) : {
      discussionTime: 120,
      nightTime: 60,
      revealRole: true
    };
  });

  // Role configuration for custom games
  const [roleConfig, setRoleConfig] = useState(() => {
    const savedRoleConfig = localStorage.getItem('vampire_role_config');
    return savedRoleConfig ? JSON.parse(savedRoleConfig) : {
      useDefault: true,
      Investigator: 1,
      Lookout: 1,
      Doctor: 1,
      Vampire: 1,
      Jester: 1
    };
  });

  // Theme selection - default to Christmas theme
  const [selectedTheme, setSelectedTheme] = useState(() => {
    const savedTheme = localStorage.getItem('vampire_theme');
    return savedTheme || 'christmas'; // Default to Christmas theme
  });

  // 1. Check for existing session on load and attempt rejoin
  useEffect(() => {
    const savedCode = localStorage.getItem('vampire_code');
    const savedId = localStorage.getItem('vampire_id');

    if (savedCode && savedId) {
      socket.emit('rejoin_game', { code: savedCode, playerId: savedId });
    }
  }, []);

  // 1.1 Check for join code in URL query parameter (?join=CODE)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const joinCode = urlParams.get('join');

    if (joinCode && view === 'MENU') {
      // Set the code and trigger join flow
      setCode(joinCode.toUpperCase());
      setPendingCode(joinCode.toUpperCase());
      setIsCreating(false);
      setView('ENTER_USERNAME');

      // Clean up URL without reloading page
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [view]);

  // 1.2 Handle phase transitions/side-effects
  useEffect(() => {
    const prev = prevGameState.current;
    if (!gameState) return;

    // Reset nightTarget when entering a new NIGHT phase (different round)
    if (gameState.state === 'NIGHT' && (!prev || prev.state !== 'NIGHT' || prev.round !== gameState.round)) {
      setNightTarget(null);
    }
    // Reset voteTarget when entering DAY_VOTE
    if (gameState.state === 'DAY_VOTE' && prev?.state !== 'DAY_VOTE') {
      setVoteTarget(null);
    }

    prevGameState.current = gameState;
  }, [gameState]);

  // 1.5 Theme switching based on game phase and user selection
  useEffect(() => {
    const isDayPhase = gameState?.state === 'DAY_DISCUSS' || gameState?.state === 'DAY_VOTE';
    const isNightPhase = gameState?.state === 'NIGHT';
    const isInGame = gameState?.state && gameState.state !== 'LOBBY';

    // Always remove phase attribute first
    document.documentElement.removeAttribute('data-phase');

    if (selectedTheme === 'christmas') {
      // Christmas theme with day/night variants
      if (isInGame) {
        if (isDayPhase) {
          document.documentElement.setAttribute('data-theme', 'christmas-day');
        } else if (isNightPhase) {
          document.documentElement.setAttribute('data-theme', 'christmas-night');
        } else {
          document.documentElement.setAttribute('data-theme', 'christmas');
        }
      } else {
        // Menu/lobby uses base christmas theme
        document.documentElement.setAttribute('data-theme', 'christmas');
      }
    } else if (isInGame) {
      // During gameplay with non-Christmas theme, use day/night themes
      if (isDayPhase) {
        document.documentElement.setAttribute('data-theme', 'day');
      } else if (isNightPhase) {
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.setAttribute('data-phase', 'night');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
    } else {
      // In menu/lobby with non-Christmas theme
      if (selectedTheme === 'day') {
        document.documentElement.setAttribute('data-theme', 'day');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
    }

    // Cleanup on unmount
    return () => {
      document.documentElement.removeAttribute('data-theme');
      document.documentElement.removeAttribute('data-phase');
    };
  }, [gameState?.state, selectedTheme]);

  // Handle theme change
  const changeTheme = (theme) => {
    setSelectedTheme(theme);
    localStorage.setItem('vampire_theme', theme);
  };

  // 2. Socket Listeners
  useEffect(() => {
    socket.on('game_created', ({ code, playerId }) => {
      saveSession(code, playerId, name);
      setView('LOBBY');
    });

    socket.on('joined', ({ code, playerId }) => {
      saveSession(code, playerId, name);
      setMyId(playerId);
      setView('LOBBY');
    });

    socket.on('game_update', (data) => {
      setGameState(data);
      setTimer(data.timer);
      // Update view based on game state
      if (data.state === 'LOBBY') {
        setView('LOBBY');
        localStorage.setItem('vampire_view', 'LOBBY');
      } else if (data.state !== 'LOBBY') {
        setView('GAME');
        localStorage.setItem('vampire_view', 'GAME');
      }
    });

    socket.on('timer_update', (t) => setTimer(t));

    socket.on('role_info', (data) => {
      setMyRole(data);
      localStorage.setItem('vampire_role', JSON.stringify(data));
    });

    socket.on('private_message', (msg) => {
      setPrivateMsg(prev => {
        const newMsg = `> ${msg}\n` + prev;
        localStorage.setItem('vampire_private_msg', newMsg);
        return newMsg;
      });
    });

    socket.on('kicked', () => {
      clearSession();
      alert("You have been kicked from the game.");
      window.location.reload();
    });

    socket.on('error', (msg) => {
      // If error related to rejoin, clear storage
      if (msg === 'Game no longer exists.') clearSession();
      alert(msg);
    });

    socket.on('player_role_info', (data) => {
      setSelectedPlayerRole(data);
    });

    return () => socket.off();
  }, [view, name]);

  // Helpers
  const saveSession = (c, id, n) => {
    localStorage.setItem('vampire_code', c);
    localStorage.setItem('vampire_id', id);
    localStorage.setItem('vampire_name', n);
    localStorage.setItem('vampire_view', 'LOBBY');
    setCode(c);
    setMyId(id);
  };

  const clearSession = () => {
    localStorage.removeItem('vampire_code');
    localStorage.removeItem('vampire_id');
    localStorage.removeItem('vampire_name');
    localStorage.removeItem('vampire_view');
    localStorage.removeItem('vampire_role');
    localStorage.removeItem('vampire_private_msg');
    localStorage.removeItem('vampire_settings');
    localStorage.removeItem('vampire_role_config');
    setView('MENU');
    setCode('');
    setMyId(null);
    setMyRole(null);
    setPrivateMsg('');
  };

  // Actions
  const initiateCreateGame = () => {
    setIsCreating(true);
    setView('ENTER_USERNAME');
  };

  const initiateJoinGame = () => {
    if (!code.trim()) return alert("Code required");
    setPendingCode(code.toUpperCase());
    setIsCreating(false);
    setView('ENTER_USERNAME');
  };

  const submitUsername = () => {
    const finalName = name.trim() || generateRandomUsername();
    setName(finalName);

    if (isCreating) {
      socket.emit('create_game', { name: finalName, settings, roleConfig });
    } else {
      socket.emit('join_game', { code: pendingCode, name: finalName });
    }
  };

  const kickPlayer = (targetId) => {
    if (window.confirm("Kick this player?")) {
      socket.emit('kick_player', { code, targetId });
    }
  };

  const startGame = () => socket.emit('start_game', { code, roleConfig });
  const sendAction = (targetId, type) => {
    // Toggle behavior: if clicking same target with same action, clear it
    if (nightTarget?.targetId === targetId && nightTarget?.type === type) {
      socket.emit('night_action', { code, action: { targetId: null, type, clear: true } });
      setNightTarget(null);
      setPrivateMsg(prev => {
        const newMsg = `> Cancelled action\n` + prev;
        localStorage.setItem('vampire_private_msg', newMsg);
        return newMsg;
      });
      return;
    }
    socket.emit('night_action', { code, action: { targetId, type } });
    setNightTarget({ targetId, type });
    const targetPlayer = gameState?.players.find(p => p.id === targetId);
    setPrivateMsg(prev => {
      const actionNames = { 'INVESTIGATE': 'Investigating', 'LOOKOUT': 'Watching', 'BITE': 'Voting for', 'HEAL': 'Healing' };
      const newMsg = `> ${actionNames[type] || 'Action on'}: ${targetPlayer?.name || 'Unknown'}\n` + prev;
      localStorage.setItem('vampire_private_msg', newMsg);
      return newMsg;
    });
  };
  const vote = (targetId) => {
    // Toggle behavior: if clicking same target, unvote
    if (voteTarget === targetId) {
      socket.emit('day_vote', { code, targetId: null });
      setVoteTarget(null);
      return;
    }
    socket.emit('day_vote', { code, targetId });
    setVoteTarget(targetId);
  };
  const skipTimer = () => socket.emit('skip_timer', { code });
  const endGame = () => {
    if (window.confirm("Are you sure you want to end the game?")) {
      socket.emit('end_game', { code });
    }
  };

  const addNPC = () => socket.emit('add_npc', { code });

  const viewPlayerRole = (targetId) => {
    socket.emit('get_player_role', { code, targetId });
  };

  const changePlayerRole = (targetId, newRole) => {
    socket.emit('change_player_role', { code, targetId, newRole });
  };

  const changePlayerAliveStatus = (targetId, isAlive) => {
    socket.emit('set_player_alive_status', { code, targetId, alive: isAlive });
  };

  const logout = () => {
    clearSession();
    window.location.reload();
  };

  // --- RENDER ---

  if (view === 'MENU') {
    return (
      <div className="container center-screen">
        {selectedTheme === 'christmas' && <Snowfall />}
        <h1 className="title-blood">VAMPIRES</h1>

        <div className="row">
          <div className="card menu-card">
            <h3>Create Room</h3>
            <div className="setting-row">
              <label>Discussion (s)</label>
              <input type="number" value={settings.discussionTime} onChange={e => {
                const newSettings = { ...settings, discussionTime: parseInt(e.target.value) };
                setSettings(newSettings);
                localStorage.setItem('vampire_settings', JSON.stringify(newSettings));
              }} />
            </div>
            <div className="setting-row">
              <label>Night (s)</label>
              <input type="number" value={settings.nightTime} onChange={e => {
                const newSettings = { ...settings, nightTime: parseInt(e.target.value) };
                setSettings(newSettings);
                localStorage.setItem('vampire_settings', JSON.stringify(newSettings));
              }} />
            </div>
            <button className="btn-primary" onClick={initiateCreateGame}>Create Game</button>
          </div>

          <div className="card menu-card">
            <h3>Join Room</h3>
            <input className="input-modern" placeholder="ROOM CODE" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
            <button className="btn-secondary" onClick={initiateJoinGame}>Join Game</button>
          </div>
        </div>

        {/* Theme Selector */}
        <div className="theme-selector">
          <button
            className={`theme-btn theme-dark ${selectedTheme === 'dark' ? 'active' : ''}`}
            onClick={() => changeTheme('dark')}
            title="Dark Theme"
          >
            🌙
          </button>
          <button
            className={`theme-btn theme-light ${selectedTheme === 'day' ? 'active' : ''}`}
            onClick={() => changeTheme('day')}
            title="Light Theme"
          >
            ☀️
          </button>
          <button
            className={`theme-btn theme-christmas ${selectedTheme === 'christmas' ? 'active' : ''}`}
            onClick={() => changeTheme('christmas')}
            title="Christmas Theme"
          >
            🎄
          </button>
        </div>
      </div>
    );
  }

  if (view === 'ENTER_USERNAME') {
    return (
      <div className="container center-screen">
        {selectedTheme === 'christmas' && <Snowfall />}
        <h1 className="title-blood">VAMPIRES</h1>
        <div className="card menu-card username-card">
          <h3>{isCreating ? 'Create Your Identity' : 'Enter Your Identity'}</h3>
          <p className="hint-text">Leave empty for a random name</p>
          <div className="input-group">
            <input
              className="input-modern"
              placeholder="Enter Username (optional)"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && submitUsername()}
              autoFocus
            />
          </div>
          <div className="button-row">
            <button className="btn-secondary" onClick={() => { setView('MENU'); setName(''); }}>Back</button>
            <button className="btn-primary" onClick={submitUsername}>
              {name.trim() ? 'Continue' : 'Get Random Name'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'LOBBY') {
    const isHost = gameState?.host === myId;
    const playerCount = gameState?.players?.length || 0;

    // Role configuration helpers
    const roleData = [
      { key: 'Investigator', icon: '🔍', alignment: 'good', name: 'Investigator' },
      { key: 'Lookout', icon: '👁️', alignment: 'good', name: 'Lookout' },
      { key: 'Doctor', icon: '💉', alignment: 'good', name: 'Doctor' },
      { key: 'Vampire', icon: '🧛', alignment: 'evil', name: 'Vampire' },
      { key: 'Jester', icon: '🃏', alignment: 'neutral', name: 'Jester' }
    ];

    const totalConfiguredRoles = roleConfig.Investigator + roleConfig.Lookout + roleConfig.Doctor + roleConfig.Vampire + roleConfig.Jester;
    const citizenCount = Math.max(0, playerCount - totalConfiguredRoles);

    const updateRoleCount = (roleKey, delta) => {
      const newCount = Math.max(0, (roleConfig[roleKey] || 0) + delta);
      const newConfig = { ...roleConfig, [roleKey]: newCount };
      setRoleConfig(newConfig);
      localStorage.setItem('vampire_role_config', JSON.stringify(newConfig));
    };

    const toggleRoleMode = (useDefault) => {
      const newConfig = { ...roleConfig, useDefault };
      setRoleConfig(newConfig);
      localStorage.setItem('vampire_role_config', JSON.stringify(newConfig));
    };

    return (
      <div className="container">
        {selectedTheme === 'christmas' && <Snowfall />}
        <div className="lobby-header">
          <h1>Lobby: <span className="highlight-code">{code}</span></h1>
          <div className="lobby-header-buttons">
            <button
              className="btn-small btn-share"
              onClick={() => setShowShareModal(true)}
            >
              Share
            </button>
            <button className="btn-small" onClick={logout}>Leave</button>
          </div>
        </div>

        {/* Share Modal */}
        {showShareModal && (
          <div className="modal-overlay" onClick={() => setShowShareModal(false)}>
            <div className="modal-content share-modal" onClick={e => e.stopPropagation()}>
              <h2>Share Game</h2>
              <p className="share-subtitle">Scan QR code or copy the link below</p>

              <div className="qr-code-container">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`${window.location.origin}${window.location.pathname}?join=${code}`)}`}
                  alt="QR Code to join game"
                  className="qr-code"
                />
              </div>

              <div className="share-url-container">
                <input
                  type="text"
                  readOnly
                  value={`${window.location.origin}${window.location.pathname}?join=${code}`}
                  className="share-url-input"
                  onClick={e => e.target.select()}
                />
                <button
                  className={`btn-copy ${shareLinkCopied ? 'copied' : ''}`}
                  onClick={() => {
                    const shareUrl = `${window.location.origin}${window.location.pathname}?join=${code}`;

                    // Clipboard API fallback for non-HTTPS contexts
                    const copyToClipboard = (text) => {
                      if (navigator.clipboard && window.isSecureContext) {
                        return navigator.clipboard.writeText(text);
                      } else {
                        const textArea = document.createElement('textarea');
                        textArea.value = text;
                        textArea.style.position = 'fixed';
                        textArea.style.left = '-999999px';
                        textArea.style.top = '-999999px';
                        document.body.appendChild(textArea);
                        textArea.focus();
                        textArea.select();
                        return new Promise((resolve, reject) => {
                          document.execCommand('copy') ? resolve() : reject();
                          textArea.remove();
                        });
                      }
                    };

                    copyToClipboard(shareUrl).then(() => {
                      setShareLinkCopied(true);
                      setTimeout(() => setShareLinkCopied(false), 2000);
                    }).catch(() => {
                      alert('Failed to copy. Please select and copy manually.');
                    });
                  }}
                >
                  {shareLinkCopied ? '✓ Copied!' : '📋 Copy'}
                </button>
              </div>

              <button className="btn-secondary" onClick={() => setShowShareModal(false)}>Close</button>
            </div>
          </div>
        )}

        <div className="player-grid">
          {gameState?.players.map(p => (
            <div key={p.id} className={`player-chip ${p.isNPC ? 'npc-player' : ''}`}>
              <div className="avatar">{p.isNPC ? '🤖' : p.name.charAt(0).toUpperCase()}</div>
              <span className="player-name">{p.name} {p.id === myId ? '(You)' : ''}</span>
              {isHost && p.id !== myId && (
                <button className="btn-kick" onClick={() => kickPlayer(p.id)}>×</button>
              )}
            </div>
          ))}
        </div>

        {isHost && (
          <button className="btn-secondary btn-add-npc" onClick={addNPC}>
            + Add NPC Player
          </button>
        )}

        {/* Role Configuration Panel - Host Only */}
        {isHost && (
          <div className="role-config-panel">
            <div className="role-config-header">
              <h3>🎭 Role Configuration</h3>
              <div className="role-config-toggle">
                <button
                  className={`toggle-btn ${roleConfig.useDefault ? 'active' : ''}`}
                  onClick={() => toggleRoleMode(true)}
                >
                  Default
                </button>
                <button
                  className={`toggle-btn ${!roleConfig.useDefault ? 'active' : ''}`}
                  onClick={() => toggleRoleMode(false)}
                >
                  Custom
                </button>
              </div>
            </div>

            {roleConfig.useDefault ? (
              <div className="role-config-default-message">
                Roles will be automatically assigned based on player count.
                <br />
                <small>(~10% each for Investigators, Lookouts, Vampires, 1 Jester, rest Citizens)</small>
              </div>
            ) : (
              <>
                <div className="role-config-grid">
                  {roleData.map(role => (
                    <div key={role.key} className={`role-config-card ${role.alignment}`}>
                      <div className="role-config-card-header">
                        <div className="role-config-card-title">
                          <span className="role-config-icon">{role.icon}</span>
                          <span className="role-config-name">{role.name}</span>
                        </div>
                        <span className={`role-config-alignment ${role.alignment}`}>
                          {role.alignment}
                        </span>
                      </div>
                      <div className="role-config-counter">
                        <button
                          className="counter-btn"
                          onClick={() => updateRoleCount(role.key, -1)}
                          disabled={roleConfig[role.key] <= 0}
                        >
                          −
                        </button>
                        <span className="counter-value">{roleConfig[role.key] || 0}</span>
                        <button
                          className="counter-btn"
                          onClick={() => updateRoleCount(role.key, 1)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Citizen card - shows auto-calculated count */}
                  <div className="role-config-card good">
                    <div className="role-config-card-header">
                      <div className="role-config-card-title">
                        <span className="role-config-icon">👤</span>
                        <span className="role-config-name">Citizen</span>
                      </div>
                      <span className="role-config-alignment good">good</span>
                    </div>
                    <div className="role-config-counter">
                      <span className="counter-value" style={{ minWidth: 'auto', opacity: 0.7 }}>
                        {citizenCount} (auto)
                      </span>
                    </div>
                  </div>
                </div>

                <div className="role-config-summary">
                  <div className="role-summary-item">
                    Players: <span>{playerCount}</span>
                  </div>
                  <div className="role-summary-item">
                    Configured: <span>{totalConfiguredRoles}</span> + <span>{citizenCount}</span> Citizens
                  </div>
                  {totalConfiguredRoles > playerCount && (
                    <div className="role-summary-warning">
                      ⚠️ More roles than players! Some roles will be randomly excluded.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {isHost ? (
          <button className="btn-primary btn-large" onClick={startGame}>START NIGHT</button>
        ) : (
          <div className="waiting-text">Waiting for host to start...</div>
        )}
      </div>
    );
  }

  // GAME VIEW
  const amIAlive = gameState?.players.find(p => p.id === myId)?.alive;
  const isNight = gameState?.state === 'NIGHT';
  const isVoting = gameState?.state === 'DAY_VOTE';
  const canTurn = (gameState?.round % 2 === 0);
  const isHost = gameState?.host === myId;
  const isGameActive = gameState?.state !== 'LOBBY' && gameState?.state !== 'GAME_OVER';

  return (
    <div className="container game-layout">
      {selectedTheme === 'christmas' && <Snowfall />}
      <div className="game-header">
        <div className="phase-indicator">
          <span className="phase-label">{gameState?.state.replace('_', ' ')}</span>
          <span className="timer-badge">{timer}s</span>
        </div>
        <div className="role-display" onClick={() => setRoleRevealed(true)} title="Click to see your role">
          <span className="role-label">Role</span>
          <span className="role-value">Show</span>
        </div>
        {isHost && isGameActive && (
          <div className="host-controls">
            <button className="btn-small btn-skip" onClick={skipTimer}>Skip Timer</button>
            <button className="btn-small btn-end" onClick={endGame}>End Game</button>
          </div>
        )}
      </div>

      {/* My Role Info Panel */}
      {roleRevealed && (
        <div className="modal-overlay" onClick={() => setRoleRevealed(false)}>
          <div className="modal-content role-info-panel" onClick={e => e.stopPropagation()}>
            <h2>Your Role</h2>
            <div className={`role-name ${myRole?.alignment}`}>{myRole?.role || '???'}</div>
            <div className="role-details">
              <div className="role-detail-row">
                <span className="detail-label">Alignment</span>
                <span className={`detail-value alignment-${myRole?.alignment}`}>
                  {ROLE_INFO[myRole?.role]?.alignment || myRole?.alignment || 'Unknown'}
                </span>
              </div>
              <div className="role-detail-row">
                <span className="detail-label">Ability</span>
                <span className="detail-value">{ROLE_INFO[myRole?.role]?.ability || 'Unknown ability'}</span>
              </div>
              <div className="role-detail-row">
                <span className="detail-label">Goal</span>
                <span className="detail-value">{ROLE_INFO[myRole?.role]?.goal || 'Unknown goal'}</span>
              </div>
            </div>
            <button className="btn-secondary" onClick={() => setRoleRevealed(false)}>Close</button>
          </div>
        </div>
      )}

      {!amIAlive && <div className="banner-dead">YOU ARE DEAD</div>}

      {/* Vampire voting info panel */}
      {myRole?.role === 'Vampire' && isNight && canTurn && gameState?.vampireInfo?.needsVoting && (
        <div className="vampire-voting-banner">
          🧛 Vampire Vote: {gameState.vampireInfo.totalVampires} vampires active.
          Target with the most votes will be turned!
        </div>
      )}

      {/* Doctor Info Banner */}
      {myRole?.role === 'Doctor' && (
        <div className="role-info-banner doctor-banner">
          💉 You have <strong>{gameState?.healsRemaining ?? '?'}</strong> heals remaining.
        </div>
      )}

      {gameState?.state === 'GAME_OVER' &&
        <div className="modal-overlay">
          <div className="modal-content game-over-panel">
            <h1>GAME OVER</h1>
            <h2 className={`winner-title ${gameState.winner === 'GOOD' ? 'good-win' : gameState.winner === 'EVIL' ? 'evil-win' : 'neutral-win'}`}>
              Winner: {gameState.winner === 'GOOD' ? 'Citizens' : gameState.winner === 'EVIL' ? 'Vampires' : gameState.winner}
            </h2>

            <div className="game-over-summary">
              <h3>Player Roles</h3>
              <div className="summary-grid">
                {gameState.players.map(p => (
                  <div key={p.id} className={`summary-card ${p.alignment || 'unknown'}`}>
                    <div className="summary-name">{p.name} {p.id === myId && '(You)'}</div>
                    <div className="summary-role">{p.role || 'Unknown'}</div>
                    {!p.alive && <div className="summary-dead">👻 Dead</div>}
                  </div>
                ))}
              </div>
            </div>

            <button className="btn-primary" onClick={logout}>Back to Menu</button>
          </div>
        </div>
      }

      {/* Role Info Modal for Host */}
      {selectedPlayerRole && (
        <div className="modal-overlay" onClick={() => setSelectedPlayerRole(null)}>
          <div className="modal-content role-modal" onClick={e => e.stopPropagation()}>
            <h2>{selectedPlayerRole.name}</h2>
            {selectedPlayerRole.isNPC && <span className="npc-badge">🤖 NPC</span>}
            <div className="role-info-display">
              <div className={`role-value large ${selectedPlayerRole.alignment}`}>
                {selectedPlayerRole.role || 'No role assigned'}
              </div>
              <p className="alignment-text">
                Alignment: <strong>{selectedPlayerRole.alignment || 'Unknown'}</strong>
              </p>
              {/* New Status Display */}
              <p className="status-text">
                Status: <strong className={selectedPlayerRole.alive ? 'status-alive' : 'status-dead'}>
                  {selectedPlayerRole.alive ? 'Alive' : 'Dead'}
                </strong>
              </p>
            </div>

            {/* Role Change Buttons for Host */}
            <div className="role-change-section">
              <h4>Change Role</h4>
              <div className="role-change-buttons">
                {['Investigator', 'Lookout', 'Doctor', 'Citizen', 'Vampire', 'Jester'].map(role => (
                  <button
                    key={role}
                    className={`btn-role-change ${selectedPlayerRole.role === role ? 'active' : ''} ${role === 'Vampire' ? 'evil' : role === 'Jester' ? 'neutral' : 'good'}`}
                    onClick={() => changePlayerRole(selectedPlayerRole.playerId, role)}
                    disabled={selectedPlayerRole.role === role}
                  >
                    {role === 'Investigator' && '🔍 '}
                    {role === 'Lookout' && '👁️ '}
                    {role === 'Doctor' && '💉 '}
                    {role === 'Citizen' && '👤 '}
                    {role === 'Vampire' && '🧛 '}
                    {role === 'Jester' && '🃏 '}
                    {role}
                  </button>
                ))}
              </div>
            </div>

            {/* Kill/Revive Buttons for Host */}
            <div className="role-change-section" style={{ marginTop: '1rem' }}>
              <h4>Lifecycle</h4>
              <div className="role-change-buttons">
                <button
                  className="btn-role-change bad"
                  style={{ background: 'var(--danger)', color: 'white', borderColor: 'var(--danger)' }}
                  onClick={() => changePlayerAliveStatus(selectedPlayerRole.playerId, false)}
                  disabled={!selectedPlayerRole.alive}
                >
                  💀 Kill
                </button>
                <button
                  className="btn-role-change good"
                  style={{ background: 'var(--primary)', color: 'white', borderColor: 'var(--primary)' }}
                  onClick={() => changePlayerAliveStatus(selectedPlayerRole.playerId, true)}
                  disabled={selectedPlayerRole.alive}
                >
                  😇 Revive
                </button>
              </div>
            </div>

            <button className="btn-secondary" onClick={() => setSelectedPlayerRole(null)}>Close</button>
          </div>
        </div>
      )}

      <div className="game-board">
        <div className="players-section">
          {gameState?.players.map(p => (
            <div key={p.id} className={`game-player-card ${!p.alive ? 'dead' : ''} ${p.id === myId ? 'me' : ''} ${p.isNPC ? 'npc-card' : ''} ${nightTarget?.targetId === p.id && isNight ? 'target-night' : ''} ${p.isVampire && myRole?.role === 'Vampire' ? 'vampire-teammate' : ''}`}>
              {/* Vampire teammate indicator - always visible to vampires */}
              {p.isVampire && myRole?.role === 'Vampire' && p.id !== myId && (
                <div className="vampire-badge">🧛 Vampire</div>
              )}
              {/* Target indicator badges */}
              {nightTarget?.targetId === p.id && isNight && (
                <div className="target-badge night-target-badge">
                  {nightTarget.type === 'INVESTIGATE' && '🔍 Investigating'}
                  {nightTarget.type === 'LOOKOUT' && '👁️ Watching'}
                  {nightTarget.type === 'BITE' && '🧛 Voted'}
                  {nightTarget.type === 'HEAL' && '💉 Healing'}
                </div>
              )}

              {/* Vampire vote count badge - visible to vampires during turning nights */}
              {myRole?.role === 'Vampire' && isNight && canTurn && !p.isVampire && p.vampireVotes > 0 && (
                <div className="vampire-vote-count-badge">
                  🩸 {p.vampireVotes} vote{p.vampireVotes > 1 ? 's' : ''}
                </div>
              )}

              <div className="card-top">
                <span
                  className={`name ${isHost ? 'clickable-name' : ''}`}
                  onClick={() => isHost && viewPlayerRole(p.id)}
                  title={isHost ? 'Click to view role' : ''}
                >
                  {p.isNPC && '🤖 '}{p.name}
                </span>
                {p.alive && isVoting && amIAlive && p.id !== myId && (
                  <button className={`btn-vote ${voteTarget === p.id ? 'voted' : ''}`} onClick={() => vote(p.id)}>
                    {voteTarget === p.id ? '✓ Voted' : 'Vote'} ({p.votes})
                  </button>
                )}
                {/* Show vote count even if I can't vote */}
                {(!amIAlive || !isVoting) && p.votes > 0 && <span className="vote-count">{p.votes} votes</span>}
              </div>

              {p.alive && isNight && amIAlive && (p.id !== myId || myRole?.role === 'Doctor') && (
                <div className="action-buttons">
                  {myRole?.role === 'Investigator' && (
                    <button className={`btn-action ${nightTarget?.targetId === p.id ? 'action-selected' : ''}`} onClick={() => sendAction(p.id, 'INVESTIGATE')}>
                      {nightTarget?.targetId === p.id ? '✓ Investigating' : 'Investigate'}
                    </button>
                  )}
                  {myRole?.role === 'Lookout' && (
                    <button className={`btn-action ${nightTarget?.targetId === p.id ? 'action-selected' : ''}`} onClick={() => sendAction(p.id, 'LOOKOUT')}>
                      {nightTarget?.targetId === p.id ? '✓ Watching' : 'Watch'}
                    </button>
                  )}
                  {myRole?.role === 'Vampire' && canTurn && !p.isVampire && (
                    <button className={`btn-action btn-danger ${nightTarget?.targetId === p.id ? 'action-selected' : ''}`} onClick={() => sendAction(p.id, 'BITE')}>
                      {nightTarget?.targetId === p.id ? '✓ Voted' : 'Vote to Turn'} {p.vampireVotes > 0 ? `(${p.vampireVotes})` : ''}
                    </button>
                  )}
                  {myRole?.role === 'Doctor' && (gameState?.healsRemaining > 0 || nightTarget?.type === 'HEAL') && (
                    <button className={`btn-action btn-good ${nightTarget?.targetId === p.id ? 'action-selected' : ''}`} onClick={() => sendAction(p.id, 'HEAL')}>
                      {nightTarget?.targetId === p.id ? '✓ Healing' : 'Heal'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="sidebar">
          <div className="panel logs-panel">
            <h4>Game Logs</h4>
            <div className="scroll-box">
              {gameState?.logs.map((l, i) => <div key={i} className="log-entry">{l}</div>)}
            </div>
          </div>
          <div className="panel private-panel">
            <h4>Private Notes</h4>
            <div className="scroll-box private-text">
              <pre>{privateMsg || "No private info yet..."}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;