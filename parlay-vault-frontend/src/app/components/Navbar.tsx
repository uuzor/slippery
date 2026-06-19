'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  useConnectWallet,
  useCurrentAccount,
  useDisconnectWallet,
  useWallets,
} from '@mysten/dapp-kit';
import { isEnokiWallet } from '@mysten/enoki';

const NAV_ITEMS = [
  { label: 'Trade', href: '/trade' },
  { label: 'Liquidity', href: '/liquidity' },
  { label: 'Markets', href: '/markets' },
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'Earn', href: '/#earn' },
  { label: 'Features', href: '/#features' },
] as const;

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const currentAccount = useCurrentAccount();
  const { mutate: disconnect, isPending: isDisconnecting } = useDisconnectWallet();
  const { mutate: connect, isPending: isConnecting } = useConnectWallet();
  const enokiWallets = useWallets().filter(isEnokiWallet);
  const googleWallet = enokiWallets.find((w) => w.provider === 'google');

  useEffect(() => {
    console.log('[auth:state] wallets=%d, google=%s, account=%s', enokiWallets.length, googleWallet ? 'yes' : 'no', currentAccount?.address ?? 'null');
  }, [enokiWallets.length, googleWallet, currentAccount?.address]);

  const shortAddress = useMemo(() => {
    if (!currentAccount?.address) return null;
    return `${currentAccount.address.slice(0, 6)}...${currentAccount.address.slice(-4)}`;
  }, [currentAccount?.address]);

  async function handleCopyAddress() {
    if (!currentAccount?.address) return;
    try {
      await navigator.clipboard.writeText(currentAccount.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Fallback for browsers that block the async clipboard API (e.g. insecure
      // contexts where the page isn't https / localhost). Try the legacy
      // execCommand path so the action still does *something* useful.
      const ta = document.createElement('textarea');
      ta.value = currentAccount.address;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (e2) {
        console.error('[auth:copy] Failed to copy address', e2);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  function handleSignIn() {
    if (!googleWallet) {
      console.warn('[auth:signin] no googleWallet — Enoki wallets not yet registered');
      return;
    }
    console.log('[auth:signin] calling connect, wallet name=%s, accounts=%d', googleWallet.name, googleWallet.accounts.length);
    connect(
      { wallet: googleWallet },
      {
        onSuccess: (data) => console.log('[auth:signin] connect onSuccess, accounts=%o', data?.accounts?.map((a: { address: string }) => a.address)),
        onError: (err) => console.error('[auth:signin] connect onError', err),
      },
    );
  }

  const isLoading = isConnecting || isDisconnecting;
  const signInDisabled = isLoading || !googleWallet;
  const signInLabel = isConnecting
    ? 'Opening Google...'
    : !googleWallet
      ? 'Loading...'
      : 'Sign in with Google';

  return (
    <nav style={styles.nav}>
      <div className="container" style={styles.inner}>

        {/* Logo */}
        <Link href="/" style={styles.logo}>
          <span style={styles.logoMark}>▲</span>
          <span style={styles.logoText}>Parlay Vault</span>
        </Link>

        {/* Desktop links */}
        <div style={styles.links}>
          {NAV_ITEMS.map((item) => (
            <Link key={item.label} href={item.href} style={styles.link}>
              {item.label}
            </Link>
          ))}
        </div>

        {/* Right side */}
        <div style={styles.right}>
          {/* Sui badge */}
          <div style={styles.suiBadge}>
            <span style={styles.suiDot} />
            <span style={styles.suiLabel}>Sui Network</span>
          </div>

          {currentAccount?.address ? (
            <div style={styles.loggedIn}>
              <button
                type="button"
                onClick={handleCopyAddress}
                aria-label={copied ? 'Address copied to clipboard' : `Copy full wallet address ${currentAccount.address}`}
                title={copied ? 'Copied!' : 'Click to copy full address'}
                style={{
                  ...styles.addressPill,
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {copied ? (
                  <>
                    <span aria-hidden>✓</span>
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <span>{shortAddress}</span>
                    <span aria-hidden style={{ opacity: 0.6, fontSize: 11 }}>⧉</span>
                  </>
                )}
              </button>
              <button
                className="btn-connect"
                onClick={() => disconnect()}
                disabled={isDisconnecting}
                style={{ background: '#222', color: '#9b9b9b' }}
              >
                {isDisconnecting ? 'Signing out...' : 'Sign out'}
              </button>
            </div>
          ) : (
            <button
              className="btn-connect"
              onClick={handleSignIn}
              disabled={signInDisabled}
            >
              {signInLabel}
            </button>
          )}

          {/* Mobile hamburger */}
          <button
            style={styles.hamburger}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Menu"
          >
            <span style={styles.bar} />
            <span style={styles.bar} />
            <span style={styles.bar} />
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div style={styles.mobileMenu}>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              style={styles.mobileLink}
              onClick={() => setMenuOpen(false)}
            >
              {item.label}
            </Link>
          ))}
          {currentAccount?.address ? (
            <>
              <button
                type="button"
                onClick={handleCopyAddress}
                aria-label={copied ? 'Address copied to clipboard' : `Copy full wallet address ${currentAccount.address}`}
                style={{
                  ...styles.addressPill,
                  width: '100%',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {copied ? (
                  <>
                    <span aria-hidden>✓</span>
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <span>{shortAddress}</span>
                    <span aria-hidden style={{ opacity: 0.6, fontSize: 11 }}>⧉</span>
                  </>
                )}
              </button>
              <button
                className="btn-connect"
                onClick={() => disconnect()}
                disabled={isDisconnecting}
                style={{ width: '100%', justifyContent: 'center', background: '#222', color: '#9b9b9b' }}
              >
                {isDisconnecting ? 'Signing out...' : 'Sign out'}
              </button>
            </>
          ) : (
            <button
              className="btn-connect"
              onClick={handleSignIn}
              disabled={signInDisabled}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {signInLabel}
            </button>
          )}
        </div>
      )}
    </nav>
  );
}

const styles: Record<string, React.CSSProperties> = {
  nav: {
    position: 'sticky',
    top: 0,
    zIndex: 100,
    background: 'rgba(10,10,10,0.92)',
    backdropFilter: 'blur(12px)',
    borderBottom: '1px solid #222222',
  },
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 64,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textDecoration: 'none',
  },
  logoMark: {
    fontSize: 18,
    color: '#3fe280',
  },
  logoText: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '-0.3px',
  },
  links: {
    display: 'flex',
    gap: 32,
    alignItems: 'center',
  },
  link: {
    fontSize: 14,
    fontWeight: 400,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    textDecoration: 'none',
    transition: 'color 0.15s',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  suiBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#171717',
    border: '1px solid #222222',
    borderRadius: 9999,
    padding: '5px 12px',
  },
  suiDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#3fe280',
    display: 'block',
  },
  suiLabel: {
    fontSize: 12,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
  loggedIn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  addressPill: {
    fontSize: 12,
    color: '#3fe280',
    background: '#171717',
    border: '1px solid #3fe280',
    borderRadius: 9999,
    padding: '5px 12px',
    letterSpacing: '0.05em',
    fontFamily: 'monospace',
  },
  addressPillHover: {
    background: '#1f2a23',
  },
  hamburger: {
    display: 'none',
    flexDirection: 'column' as const,
    gap: 5,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
  },
  bar: {
    display: 'block',
    width: 22,
    height: 2,
    background: '#ffffff',
    borderRadius: 2,
  },
  mobileMenu: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
    padding: '24px',
    borderTop: '1px solid #222222',
    background: '#0a0a0a',
  },
  mobileLink: {
    fontSize: 16,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    textDecoration: 'none',
  },
};
