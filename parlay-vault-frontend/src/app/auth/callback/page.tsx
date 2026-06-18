'use client';

import { useEffect } from 'react';

import { useZkLogin } from '../../lib/zklogin';

// Google redirects to /auth/callback with id_token in the URL hash.
// The ZkLoginProvider useEffect on the root layout detects the hash
// and processes the token (decodes JWT, requests Groth16 proof, stores
// everything in localStorage). This page observes that state and only
// navigates home once the proof is fully minted, so a slow prover no
// longer strands the user on a half-finished session.
const STUCK_TIMEOUT_MS = 30_000;

export default function AuthCallback() {
  const { address, jwt, isLoading, error } = useZkLogin();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (error) {
      // Surface the failure and stay on the page so the user can retry
      // from the navbar without losing the error context.
      return;
    }

    if (!isLoading && address && jwt) {
      // The provider finished and the session is persisted. Hand off.
      window.location.replace('/');
    }
  }, [address, error, isLoading, jwt]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isLoading) return;

    // Failsafe: if the prover hangs for >30s, stop pretending we are
    // still completing sign in and let the user force a fresh attempt.
    const stuckTimer = window.setTimeout(() => {
      const message =
        'Sign in is taking longer than expected. The dev prover may be slow — click “Sign in with Google” again to retry.';
      // eslint-disable-next-line no-console
      console.warn('[auth/callback]', message);
      window.alert(message);
    }, STUCK_TIMEOUT_MS);
    return () => window.clearTimeout(stuckTimer);
  }, [isLoading]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.spinner} />
        <p style={styles.text}>
          {error ? 'Sign in failed' : 'Completing sign in…'}
        </p>
        <p style={styles.sub}>
          {error
            ? 'Use the “Sign in with Google” button in the navbar to retry.'
            : 'Generating your Sui address and Groth16 proof'}
        </p>
        {error ? <p style={styles.errorText}>{error}</p> : null}
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
    maxWidth: 480,
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
    margin: 0,
  },
  sub: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    margin: 0,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 13,
    color: '#ff6b6b',
    margin: 0,
    textAlign: 'center',
    wordBreak: 'break-word',
  },
};
