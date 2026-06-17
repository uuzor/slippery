'use client';

import { useEffect } from 'react';

// Google redirects to /auth/callback with id_token in the URL hash.
// The ZkLoginProvider useEffect on the root layout detects the hash
// and processes the token. This page just shows a loading state
// while that happens, then redirects home.

export default function AuthCallback() {
  useEffect(() => {
    // Give the provider useEffect time to fire and process the token,
    // then navigate home. The provider persists state to localStorage
    // so the login survives the navigation.
    const timer = setTimeout(() => {
      window.location.replace('/');
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.spinner} />
        <p style={styles.text}>Completing sign in...</p>
        <p style={styles.sub}>Generating your Sui address</p>
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    background: '#171717',
    border: '1px solid #222222',
    borderRadius: 16,
    padding: '48px 56px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
  },
  spinner: {
    width: 40,
    height: 40,
    border: '3px solid #222222',
    borderTop: '3px solid #3fe280',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  text: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '0.05em',
  },
  sub: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
};
