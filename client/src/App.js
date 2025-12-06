import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io('http://localhost:3001');

// Random username generator
const generateRandomUsername = () => {
  const adjectives = ['Shadow', 'Dark', 'Blood', 'Night', 'Crimson', 'Silent', 'Mystic', 'Ancient', 'Pale', 'Eternal'];
  const nouns = ['Hunter', 'Walker', 'Stalker', 'Slayer', 'Seeker', 'Watcher', 'Phantom', 'Specter', 'Raven', 'Wolf'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
};

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

  // Settings - also persist these
  const [settings, setSettings] = useState(() => {
    const savedSettings = localStorage.getItem('vampire_settings');
    return savedSettings ? JSON.parse(savedSettings) : {
      discussionTime: 120,
      nightTime: 60,
      revealRole: true
    };
  });

  // 1. Check for existing session on load and attempt rejoin
  useEffect(() => {
    const savedCode = localStorage.getItem('vampire_code');
    const savedId = localStorage.getItem('vampire_id');

    if (savedCode && savedId) {
      socket.emit('rejoin_game', { code: savedCode, playerId: savedId });
    }
  }, []);

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
      // Reset targets when phase changes
      if (gameState?.state !== data.state) {
        if (data.state === 'NIGHT') {
          setNightTarget(null);
        } else if (data.state === 'DAY_VOTE') {
          setVoteTarget(null);
        }
      }
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
      socket.emit('create_game', { name: finalName, settings });
    } else {
      socket.emit('join_game', { code: pendingCode, name: finalName });
    }
  };

  const kickPlayer = (targetId) => {
    if (window.confirm("Kick this player?")) {
      socket.emit('kick_player', { code, targetId });
    }
  };

  const startGame = () => socket.emit('start_game', { code });
  const sendAction = (targetId, type) => {
    socket.emit('night_action', { code, action: { targetId, type } });
    setNightTarget({ targetId, type });
    const targetPlayer = gameState?.players.find(p => p.id === targetId);
    setPrivateMsg(prev => {
      const actionNames = { 'INVESTIGATE': 'Investigating', 'LOOKOUT': 'Watching', 'BITE': 'Turning' };
      const newMsg = `> ${actionNames[type] || 'Action on'}: ${targetPlayer?.name || 'Unknown'}\n` + prev;
      localStorage.setItem('vampire_private_msg', newMsg);
      return newMsg;
    });
  };
  const vote = (targetId) => {
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

  const logout = () => {
    clearSession();
    window.location.reload();
  };

  // --- RENDER ---

  if (view === 'MENU') {
    return (
      <div className="container center-screen">
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
      </div>
    );
  }

  if (view === 'ENTER_USERNAME') {
    return (
      <div className="container center-screen">
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
    return (
      <div className="container">
        <div className="lobby-header">
          <h1>Lobby: <span className="highlight-code">{code}</span></h1>
          <button className="btn-small" onClick={logout}>Leave</button>
        </div>

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
      <div className="game-header">
        <div className="phase-indicator">
          <span className="phase-label">{gameState?.state.replace('_', ' ')}</span>
          <span className="timer-badge">{timer}s</span>
        </div>
        <div className={`role-badge ${myRole?.alignment}`}>
          Role: {myRole?.role}
        </div>
        {isHost && isGameActive && (
          <div className="host-controls">
            <button className="btn-small btn-skip" onClick={skipTimer}>Skip Timer</button>
            <button className="btn-small btn-end" onClick={endGame}>End Game</button>
          </div>
        )}
      </div>

      {!amIAlive && <div className="banner-dead">YOU ARE DEAD</div>}

      {gameState?.state === 'GAME_OVER' &&
        <div className="modal-overlay">
          <div className="modal-content">
            <h1>GAME OVER</h1>
            <h2>Winner: {gameState.winner}</h2>
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
              <div className={`role-badge large ${selectedPlayerRole.alignment}`}>
                {selectedPlayerRole.role || 'No role assigned'}
              </div>
              <p className="alignment-text">
                Alignment: <strong>{selectedPlayerRole.alignment || 'Unknown'}</strong>
              </p>
            </div>
            <button className="btn-secondary" onClick={() => setSelectedPlayerRole(null)}>Close</button>
          </div>
        </div>
      )}

      <div className="game-board">
        <div className="players-section">
          {gameState?.players.map(p => (
            <div key={p.id} className={`game-player-card ${!p.alive ? 'dead' : ''} ${p.id === myId ? 'me' : ''} ${p.isNPC ? 'npc-card' : ''} ${nightTarget?.targetId === p.id && isNight ? 'target-night' : ''} ${voteTarget === p.id && isVoting ? 'target-vote' : ''} ${p.isVampire && isNight && myRole?.role === 'Vampire' ? 'vampire-teammate' : ''}`}>
              {/* Vampire teammate indicator */}
              {p.isVampire && isNight && myRole?.role === 'Vampire' && p.id !== myId && (
                <div className="vampire-badge">🧛 Vampire</div>
              )}
              {/* Target indicator badges */}
              {nightTarget?.targetId === p.id && isNight && (
                <div className="target-badge night-target-badge">
                  {nightTarget.type === 'INVESTIGATE' && '🔍 Investigating'}
                  {nightTarget.type === 'LOOKOUT' && '👁️ Watching'}
                  {nightTarget.type === 'BITE' && '🧛 Turning'}
                </div>
              )}
              {voteTarget === p.id && isVoting && (
                <div className="target-badge vote-target-badge">🗳️ Your Vote</div>
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

              {p.alive && isNight && amIAlive && p.id !== myId && (
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
                      {nightTarget?.targetId === p.id ? '✓ Turning' : 'Turn'}
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