import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';
import { getLanguage, rememberJoinCode, LanguageSwitch } from './language';

// Each language is its own app with its own stylesheet (the Lithuanian one has a
// different design). Only the chosen one is loaded; switching language reloads the page.
const EnglishApp = lazy(() => import('./App'));
const LithuanianApp = lazy(() => import('./lt/LtApp'));

const lang = getLanguage();
rememberJoinCode();
document.documentElement.lang = lang;
document.title = lang === 'lt' ? 'Vampyrai' : 'Vampires';

const GameApp = lang === 'lt' ? LithuanianApp : EnglishApp;

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <GameApp />
    </Suspense>
    <LanguageSwitch lang={lang} />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
