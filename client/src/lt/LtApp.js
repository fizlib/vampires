import React from 'react';
import io from 'socket.io-client';
import VampireGame from './VampireGame';
import './vampires.css';

// Lithuanian version of the game (design from the protus.lt classroom version),
// connected to the same game server as the English version.
const SERVER_URL = process.env.REACT_APP_SERVER_URL || '';
const socket = io(SERVER_URL);

export default function LtApp() {
  return <VampireGame socket={socket} />;
}
