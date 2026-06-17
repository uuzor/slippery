import Link from 'next/link';

export default function Hero() {
  return (
    <section style={styles.section}>
      {/* Ambient glow */}
      <div style={styles.glow} aria-hidden />

      <div className="container">
        {/* Top label */}
        <div style={styles.topLabel}>
          <span className="tag-mint">⚡ Live on Sui Testnet</span>
          <span style={styles.separator} />
          <span style={styles.labelText}>Powered by DeepBook Predict</span>
        </div>

        {/* Two-column hero */}
        <div style={styles.grid}>

          {/* Left — headline + CTAs */}
          <div style={styles.left}>
            <h1 style={styles.headline}>
              Bet smarter.<br />
              <span style={styles.mintText}>Win together.</span>
            </h1>
            <p style={styles.sub}>
              Pick 2 to 4 sports outcomes. Stack them into one parlay bet.
              If every pick wins, you collect — plus a bonus funded by the liquidity pool.
              No wallet needed to start. Sign in with Google.
            </p>

            <div style={styles.ctaRow}>
              <Link href="/markets" className="btn-primary" style={{ borderRadius: 64 }}>
                Go to Markets
              </Link>
              <button className="btn-ghost" style={{ borderRadius: 64 }}>
                Earn as LP →
              </button>
            </div>

            {/* Trust strip */}
            <div style={styles.trustStrip}>
              {[
                { icon: '🔐', label: 'Sign in with Google — zkLogin' },
                { icon: '⛽', label: 'No gas fees for you' },
                { icon: '⛓', label: 'Fully on-chain · Sui' },
              ].map((item) => (
                <div key={item.label} style={styles.trustItem}>
                  <span>{item.icon}</span>
                  <span style={styles.trustLabel}>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right — illustration placeholder */}
          <div style={styles.right}>
            <div style={styles.illustrationBox}>
              {/* Replace this div with your actual illustration/image */}
              <div style={styles.illustrationInner}>
                <span style={styles.illustrationIcon}>🏆</span>
                <p style={styles.illustrationCaption}>Protocol illustration</p>
                <p style={{ ...styles.illustrationCaption, fontSize: 12, marginTop: 4 }}>
                  Replace with your artwork
                </p>
              </div>

              {/* Floating stat card on illustration */}
              <div style={styles.floatingCard}>
                <div style={styles.floatingLabel}>Live pool</div>
                <div style={styles.floatingValue}>$401,228 DUSDC</div>
                <div style={styles.floatingSubtext}>earning yield right now</div>
              </div>
            </div>
          </div>
        </div>

        {/* Live stats bar */}
        <div style={styles.statsBar}>
          {[
            { label: 'Total Volume', value: '$2.4M' },
            { label: 'Active Bettors', value: '847' },
            { label: 'LP Yield (avg)', value: '12.4%' },
            { label: 'Slips Settled', value: '3,291' },
          ].map((stat, i) => (
            <div key={stat.label} style={styles.statItem}>
              {i > 0 && <div style={styles.statDivider} />}
              <div style={styles.statValue}>{stat.value}</div>
              <div style={styles.statLabel}>{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    position: 'relative',
    paddingTop: 96,
    paddingBottom: 80,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: -200,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 800,
    height: 500,
    background: 'radial-gradient(ellipse, rgba(63,226,128,0.07) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  topLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 40,
  },
  separator: {
    width: 1,
    height: 16,
    background: '#222222',
    display: 'block',
  },
  labelText: {
    fontSize: 13,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 64,
    alignItems: 'center',
    marginBottom: 80,
  },
  left: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  headline: {
    fontFamily: 'Inter, sans-serif',
    fontSize: 'clamp(44px, 6vw, 72px)',
    fontWeight: 400,
    lineHeight: 1,
    letterSpacing: '-1.8px',
    color: '#ffffff',
    marginBottom: 24,
  },
  mintText: {
    color: '#3fe280',
  },
  sub: {
    fontSize: 16,
    lineHeight: 1.6,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    maxWidth: 460,
    marginBottom: 36,
  },
  ctaRow: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap' as const,
    marginBottom: 40,
  },
  trustStrip: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  trustItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  trustLabel: {
    fontSize: 13,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
  right: {
    position: 'relative',
  },
  illustrationBox: {
    position: 'relative',
    background: '#171717',
    border: '1px solid #222222',
    borderRadius: 24,
    aspectRatio: '4/3',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  illustrationInner: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    opacity: 0.3,
  },
  illustrationIcon: {
    fontSize: 64,
  },
  illustrationCaption: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
  floatingCard: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    background: '#0a0a0a',
    border: '1px solid #3fe280',
    borderRadius: 12,
    padding: '14px 18px',
  },
  floatingLabel: {
    fontSize: 11,
    color: '#9b9b9b',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    marginBottom: 4,
  },
  floatingValue: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '-0.3px',
  },
  floatingSubtext: {
    fontSize: 11,
    color: '#3fe280',
    letterSpacing: '0.05em',
    marginTop: 2,
  },
  statsBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    background: '#171717',
    border: '1px solid #222222',
    borderRadius: 12,
    overflow: 'hidden',
  },
  statItem: {
    position: 'relative',
    padding: '24px 32px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  statDivider: {
    position: 'absolute',
    left: 0,
    top: '20%',
    height: '60%',
    width: 1,
    background: '#222222',
  },
  statValue: {
    fontSize: 32,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '-0.5px',
    lineHeight: 1,
  },
  statLabel: {
    fontSize: 13,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
};
