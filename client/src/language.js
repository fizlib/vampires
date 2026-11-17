import React from 'react';

const LANG_KEY = 'vampire_lang';
const PENDING_JOIN_KEY = 'vampire_pending_join';

const safeGet = (storage, key) => {
  try {
    return storage.getItem(key);
  } catch (e) {
    return null;
  }
};

const safeSet = (storage, key, value) => {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch (e) {
    // storage unavailable - ignore
  }
};

export const getLanguage = () => {
  const saved = safeGet(localStorage, LANG_KEY);
  if (saved === 'en' || saved === 'lt') return saved;
  return (navigator.language || '').toLowerCase().startsWith('lt') ? 'lt' : 'en';
};

// The app removes ?join=CODE from the URL once it has read it. Remember it for this
// tab so that switching language (which reloads the page) keeps the invite.
export const rememberJoinCode = () => {
  const joinCode = new URLSearchParams(window.location.search).get('join');
  safeSet(sessionStorage, PENDING_JOIN_KEY, joinCode || null);
};

const switchLanguage = (lang) => {
  safeSet(localStorage, LANG_KEY, lang);
  const pendingJoin = safeGet(sessionStorage, PENDING_JOIN_KEY);
  const inGame = safeGet(localStorage, 'vampire_code');
  const search = pendingJoin && !inGame ? `?join=${encodeURIComponent(pendingJoin)}` : '';
  window.location.assign(`${window.location.pathname}${search}`);
};

const wrapStyle = {
  position: 'fixed',
  bottom: 12,
  left: 12,
  zIndex: 1000,
  display: 'flex',
  borderRadius: 999,
  overflow: 'hidden',
  border: '1px solid rgba(255, 255, 255, 0.25)',
  background: 'rgba(0, 0, 0, 0.45)',
  backdropFilter: 'blur(4px)',
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
};

const buttonStyle = (active) => ({
  border: 0,
  margin: 0,
  padding: '5px 10px',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 0.5,
  cursor: active ? 'default' : 'pointer',
  color: active ? '#fff' : 'rgba(255, 255, 255, 0.7)',
  background: active ? 'rgba(243, 85, 142, 0.85)' : 'transparent',
});

export function LanguageSwitch({ lang }) {
  return (
    <div style={wrapStyle} role="group" aria-label={lang === 'lt' ? 'Kalba' : 'Language'}>
      {['en', 'lt'].map(code => (
        <button
          key={code}
          type="button"
          style={buttonStyle(lang === code)}
          aria-pressed={lang === code}
          onClick={() => lang !== code && switchLanguage(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
