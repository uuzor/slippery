'use client';

// The hand-rolled zkLogin flow used to land here after the Google OAuth
// redirect with an `id_token` in the URL hash. Enoki replaces that flow
// with a popup-based OAuth that resolves directly into the connected
// wallet — so this page is no longer part of the sign-in path.
//
// Keeping the route as a defensive fallback: if a stale bookmark or link
// brings the user here, we bounce them home instead of leaving them on
// an empty screen.

import { useEffect } from 'react';

export default function AuthCallback() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Strip any leftover id_token hash before navigating away.
    if (window.location.hash.includes('id_token=')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    window.location.replace('/');
  }, []);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p style={styles.text}>Sign-in is handled by a popup now.</p>
        <p style={styles.sub}>Redirecting to the home page…</p>
      </div>
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
    gap: 12,
    maxWidth: 480,
  },
  text: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '0.05em',
    margin: 0,
  },
  sub: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    margin: 0,
  },
};
