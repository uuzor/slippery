const BETTOR_STEPS = [
  {
    n: '01',
    title: 'Pick your matches',
    body: 'Choose 2 to 4 sports markets — football, basketball, tennis. Each pick has odds based on the real probability of winning.',
    img: '🎯',
  },
  {
    n: '02',
    title: 'Stack them into a parlay',
    body: 'Combine your picks into one slip. The more picks you add, the higher your potential payout — plus a bonus multiplier on top.',
    img: '📋',
  },
  {
    n: '03',
    title: 'All wins = big payout',
    body: 'If every pick wins, you receive the full parlay payout plus the LP bonus. One wrong pick and the slip loses — the stake returns to the pool.',
    img: '🏆',
  },
];

const LP_STEPS = [
  {
    n: '01',
    title: 'Deposit in the vault',
    body: 'Add dUSDC to the liquidity pool at the start of an epoch. Your funds back the bonus payouts for winning bettors.',
    img: '💰',
  },
  {
    n: '02',
    title: 'Earn while you wait',
    body: "Every losing parlay slip sends its stake to the LP pool. On top of that, idle capital earns yield through DeepBook's liquidity layer.",
    img: '📈',
  },
  {
    n: '03',
    title: 'Withdraw after the epoch',
    body: 'When the epoch ends and all active slips are settled, withdraw your share plus earned yield — no surprises, no rug.',
    img: '🔓',
  },
];

export default function HowItWorks() {
  return (
    <section className="section" id="how-it-works" style={styles.section}>
      <div className="container">

        {/* Section header */}
        <div style={styles.header}>
          <span className="tag">How it works</span>
          <h2 style={styles.title}>Two ways to play</h2>
          <p style={styles.subtitle}>
            Whether you want to bet on sports or earn passive yield,
            the protocol works for you — transparently and on-chain.
          </p>
        </div>

        {/* Bettor flow */}
        <div style={styles.block}>
          <div style={styles.blockHeader}>
            <div style={styles.roleTag}>
              <span style={styles.roleDot} />
              <span style={styles.roleLabel}>For Bettors</span>
            </div>
            <p style={styles.roleDesc}>
              Place a parlay slip, sign in with Google — no crypto wallet required.
              Gasless transactions mean you never pay network fees.
            </p>
          </div>

          <div className="grid-3" style={{ gap: 16 }}>
            {BETTOR_STEPS.map((step) => (
              <div key={step.n} className="card" style={styles.stepCard}>
                {/* Illustration placeholder */}
                <div style={styles.imgPlaceholder}>
                  <span style={{ fontSize: 36 }}>{step.img}</span>
                  <span style={styles.imgNote}>Replace with illustration</span>
                </div>
                <div style={styles.stepNum}>{step.n}</div>
                <h3 style={styles.stepTitle}>{step.title}</h3>
                <p style={styles.stepBody}>{step.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="divider" style={{ margin: '64px 0' }} />

        {/* LP flow */}
        <div style={styles.block}>
          <div style={styles.blockHeader}>
            <div style={styles.roleTag}>
              <span style={{ ...styles.roleDot, background: '#3fe280' }} />
              <span style={styles.roleLabel}>For Liquidity Providers</span>
            </div>
            <p style={styles.roleDesc}>
              Deposit once per epoch. Earn from every losing slip and from DeepBook&apos;s
              native yield strategy. Exit cleanly after the epoch ends.
            </p>
          </div>

          <div className="grid-3" style={{ gap: 16 }}>
            {LP_STEPS.map((step) => (
              <div key={step.n} className="card-mint" style={styles.stepCard}>
                {/* Illustration placeholder */}
                <div style={{ ...styles.imgPlaceholder, borderColor: '#3fe28033' }}>
                  <span style={{ fontSize: 36 }}>{step.img}</span>
                  <span style={styles.imgNote}>Replace with illustration</span>
                </div>
                <div style={{ ...styles.stepNum, color: '#3fe280' }}>{step.n}</div>
                <h3 style={styles.stepTitle}>{step.title}</h3>
                <p style={styles.stepBody}>{step.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Flow diagram placeholder */}
        <div style={styles.diagramPlaceholder}>
          <span style={styles.diagramIcon}>🔄</span>
          <p style={styles.diagramText}>Protocol flow diagram</p>
          <p style={{ ...styles.diagramText, fontSize: 12, marginTop: 4, color: '#555' }}>
            Bettor stake → Predict positions → Oracle settles → Payout or LP yield
          </p>
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
    marginBottom: 72,
  },
  title: {
    fontSize: 'clamp(32px, 4vw, 44px)',
    fontWeight: 400,
    color: '#ffffff',
    letterSpacing: '-1px',
    lineHeight: 1.1,
  },
  subtitle: {
    fontSize: 16,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    maxWidth: 520,
    lineHeight: 1.6,
  },
  block: {
    marginBottom: 0,
  },
  blockHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 32,
    marginBottom: 32,
    flexWrap: 'wrap' as const,
  },
  roleTag: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  roleDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#9b9b9b',
    display: 'block',
    flexShrink: 0,
  },
  roleLabel: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '0.05em',
  },
  roleDesc: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    maxWidth: 480,
    lineHeight: 1.6,
  },
  stepCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  imgPlaceholder: {
    width: '100%',
    aspectRatio: '16/9',
    background: '#0a0a0a',
    border: '1px dashed #222222',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
  imgNote: {
    fontSize: 11,
    color: '#444',
    letterSpacing: '0.05em',
  },
  stepNum: {
    fontSize: 13,
    fontWeight: 500,
    color: '#9b9b9b',
    letterSpacing: '0.1em',
  },
  stepTitle: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '0.05em',
    lineHeight: 1.3,
  },
  stepBody: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    lineHeight: 1.6,
  },
  diagramPlaceholder: {
    marginTop: 64,
    background: '#171717',
    border: '1px dashed #222222',
    borderRadius: 12,
    padding: '48px 24px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
  },
  diagramIcon: {
    fontSize: 40,
    opacity: 0.3,
  },
  diagramText: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
};
