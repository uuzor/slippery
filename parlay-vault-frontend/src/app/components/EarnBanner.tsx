export default function EarnBanner() {
  return (
    <section className="section-sm" id="earn" style={styles.section}>
      <div className="container">
        <div style={styles.banner}>

          {/* Left */}
          <div style={styles.left}>
            <span className="tag-mint">For liquidity providers</span>
            <h2 style={styles.title}>
              Put your stablecoins to work
            </h2>
            <p style={styles.body}>
              Deposit dUSDC into the Parlay Vault LP pool. Earn from every
              losing bet slip and from DeepBook's native yield strategy.
              Funds are epoch-locked — no LP can exit while bets are live,
              so the pool is always solvent.
            </p>
            <div style={styles.metrics}>
              {[
                { label: 'Current APY', value: '12.4%', mint: true },
                { label: 'Pool size', value: '$401K' },
                { label: 'Epoch length', value: '24h' },
              ].map((m) => (
                <div key={m.label} style={styles.metric}>
                  <div style={{ ...styles.metricVal, color: m.mint ? '#3fe280' : '#ffffff' }}>
                    {m.value}
                  </div>
                  <div style={styles.metricLabel}>{m.label}</div>
                </div>
              ))}
            </div>
            <button className="btn-primary" style={{ borderRadius: 64, marginTop: 8 }}>
              Start Earning →
            </button>
          </div>

          {/* Right — illustration placeholder */}
          <div style={styles.right}>
            <div style={styles.illusBox}>
              <span style={{ fontSize: 56, opacity: 0.25 }}>💹</span>
              <p style={styles.illusText}>LP yield illustration</p>
              <p style={{ ...styles.illusText, fontSize: 12, color: '#333', marginTop: 4 }}>
                Replace with artwork
              </p>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    borderTop: '1px solid #222222',
  },
  banner: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 64,
    alignItems: 'center',
    background: '#171717',
    border: '1px solid #3fe280',
    borderRadius: 16,
    padding: '56px 56px',
  },
  left: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 20,
  },
  title: {
    fontSize: 'clamp(24px, 3vw, 36px)',
    fontWeight: 400,
    color: '#ffffff',
    letterSpacing: '-0.5px',
    lineHeight: 1.15,
  },
  body: {
    fontSize: 15,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    lineHeight: 1.65,
  },
  metrics: {
    display: 'flex',
    gap: 32,
  },
  metric: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  metricVal: {
    fontSize: 24,
    fontWeight: 500,
    letterSpacing: '-0.3px',
  },
  metricLabel: {
    fontSize: 12,
    color: '#9b9b9b',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
  },
  right: {},
  illusBox: {
    background: '#0a0a0a',
    border: '1px dashed #222222',
    borderRadius: 12,
    aspectRatio: '4/3',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  illusText: {
    fontSize: 13,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
};
