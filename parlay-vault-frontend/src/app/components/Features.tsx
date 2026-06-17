const FEATURES = [
  {
    icon: '🔐',
    title: 'Sign in with Google',
    body: 'No seed phrases. No browser extension. Use your existing Google account to get started instantly — powered by Sui zkLogin.',
    highlight: false,
  },
  {
    icon: '⛽',
    title: 'Zero gas fees',
    body: "We sponsor your transactions so you never pay network fees. Place a bet, cancel a slip, withdraw — all gasless for the user.",
    highlight: false,
  },
  {
    icon: '⛓',
    title: 'Fully on-chain & verifiable',
    body: 'Every bet, every payout, every LP position lives on Sui. Anyone can verify the outcome. No house server decides who wins.',
    highlight: true,
  },
  {
    icon: '🎯',
    title: 'Fair parlay odds',
    body: 'Odds are calculated using real joint probability math — not inflated house odds. You see exactly what the market implies.',
    highlight: false,
  },
  {
    icon: '🏦',
    title: 'LP bonus model',
    body: 'The liquidity pool only funds the all-win bonus — not the full payout. Your stake backs the Predict positions directly. LPs take less risk.',
    highlight: false,
  },
  {
    icon: '📊',
    title: 'DeepBook Predict native',
    body: 'Every leg of your parlay is a real Predict position on DeepBook. Real markets, real prices, real settlement by oracle.',
    highlight: false,
  },
];

export default function Features() {
  return (
    <section className="section" id="features" style={styles.section}>
      <div className="container">

        <div style={styles.header}>
          <span className="tag">Why Parlay Vault</span>
          <h2 style={styles.title}>
            The sports betting protocol<br />
            <span style={{ color: '#3fe280' }}>built for everyone</span>
          </h2>
          <p style={styles.subtitle}>
            Web3 users get a fully on-chain, transparent protocol.
            Everyone else gets a seamless experience — sign in, bet, win.
          </p>
        </div>

        {/* Big illustration placeholder */}
        <div style={styles.bigIllustration}>
          <span style={{ fontSize: 48, opacity: 0.2 }}>🖼</span>
          <p style={styles.illusText}>Full-width product screenshot or protocol diagram</p>
          <p style={{ ...styles.illusText, fontSize: 12, color: '#333', marginTop: 4 }}>
            1200 × 500px recommended
          </p>
        </div>

        <div className="grid-3" style={{ gap: 16, marginTop: 64 }}>
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className={f.highlight ? 'card-mint' : 'card'}
              style={styles.featureCard}
            >
              <span style={styles.icon}>{f.icon}</span>
              <h3 style={styles.featureTitle}>{f.title}</h3>
              <p style={styles.featureBody}>{f.body}</p>
              {f.highlight && (
                <div style={styles.highlightBadge}>
                  <span style={styles.highlightDot} />
                  Core protocol guarantee
                </div>
              )}
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    borderTop: '1px solid #222222',
  },
  header: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    textAlign: 'center' as const,
    gap: 16,
    marginBottom: 64,
  },
  title: {
    fontSize: 'clamp(28px, 4vw, 44px)',
    fontWeight: 400,
    color: '#ffffff',
    letterSpacing: '-1px',
    lineHeight: 1.15,
  },
  subtitle: {
    fontSize: 16,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    maxWidth: 500,
    lineHeight: 1.6,
  },
  bigIllustration: {
    background: '#171717',
    border: '1px dashed #222222',
    borderRadius: 12,
    height: 280,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  illusText: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
  featureCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  icon: {
    fontSize: 28,
    lineHeight: 1,
  },
  featureTitle: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '0.05em',
  },
  featureBody: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    lineHeight: 1.6,
    flex: 1,
  },
  highlightBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: '#3fe280',
    letterSpacing: '0.05em',
    marginTop: 4,
  },
  highlightDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#3fe280',
    display: 'block',
  },
};
