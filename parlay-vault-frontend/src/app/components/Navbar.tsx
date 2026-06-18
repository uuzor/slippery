'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useZkLogin } from '../lib/zklogin';

const NAV_ITEMS = [
  { label: 'Markets', href: '/markets' },
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'Earn', href: '/#earn' },
  { label: 'Features', href: '/#features' },
] as const;

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { address, isLoading, loginWithGoogle, logout, resetLogin } = useZkLogin();

  const shortAddress = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : null;

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

          {address ? (
            <div style={styles.loggedIn}>
              <span style={styles.addressPill}>{shortAddress}</span>
              <span className="hidden">{address}</span>
              <button
                className="btn-connect"
                onClick={resetLogin}
                title="Clear cached proof and session; sign in again to mint a fresh zkLogin proof."
                style={{ background: '#222', color: '#9b9b9b' }}
              >
                Reset
              </button>
              <button
                className="btn-connect"
                onClick={logout}
                style={{ background: '#222', color: '#9b9b9b' }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <button
              className="btn-connect"
              onClick={loginWithGoogle}
              disabled={isLoading}
            >
              {isLoading ? 'Signing in...' : 'Sign in with Google'}
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
          {address ? (
            <>
              <button
                className="btn-connect"
                onClick={resetLogin}
                style={{ width: '100%', justifyContent: 'center', background: '#222', color: '#9b9b9b' }}
              >
                Reset login ({shortAddress})
              </button>
              <button
                className="btn-connect"
                onClick={logout}
                style={{ width: '100%', justifyContent: 'center', background: '#222', color: '#9b9b9b' }}
              >
                Sign out ({shortAddress})
              </button>
            </>
          ) : (
            <button className="btn-connect" onClick={loginWithGoogle} disabled={isLoading} style={{ width: '100%', justifyContent: 'center' }}>
              {isLoading ? 'Signing in...' : 'Sign in with Google'}
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
