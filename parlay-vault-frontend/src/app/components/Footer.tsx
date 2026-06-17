export default function Footer() {
  return (
    <footer style={styles.footer}>
      <div className="container">
        <div style={styles.top}>

          {/* Brand */}
          <div style={styles.brand}>
            <div style={styles.logo}>
              <span style={{ color: '#3fe280', fontSize: 16 }}>▲</span>
              <span style={styles.logoText}>Parlay Vault</span>
            </div>
            <p style={styles.tagline}>
              Sports parlay betting powered by DeepBook Predict on Sui.
              Fair odds. Real payouts. Zero gas for users.
            </p>
            <div style={styles.badges}>
              <span className="tag">Built on Sui</span>
              <span className="tag">DeepBook Predict</span>
              <span className="tag">zkLogin</span>
            </div>
          </div>

          {/* Links */}
          <div style={styles.linkCols}>
            {[
              {
                heading: 'Product',
                links: ['Markets', 'Place a Bet', 'LP Vault', 'My Slips'],
              },
              {
                heading: 'Protocol',
                links: ['How It Works', 'Smart Contracts', 'Audits', 'Docs'],
              },
              {
                heading: 'Community',
                links: ['Twitter / X', 'Discord', 'GitHub', 'Blog'],
              },
            ].map((col) => (
              <div key={col.heading} style={styles.linkCol}>
                <div style={styles.colHeading}>{col.heading}</div>
                {col.links.map((link) => (
                  <a key={link} href="#" style={styles.link}>{link}</a>
                ))}
              </div>
            ))}
          </div>

        </div>

        <div className="divider" style={{ margin: '40px 0 24px' }} />

        <div style={styles.bottom}>
          <span style={styles.copy}>
            © 2025 Parlay Vault · Built for Sui Overflow 2026
          </span>
          <div style={styles.bottomLinks}>
            <a href="#" style={styles.link}>Privacy</a>
            <a href="#" style={styles.link}>Terms</a>
            <a href="#" style={styles.link}>Risk Disclaimer</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

const styles: Record<string, React.CSSProperties> = {
  footer: {
    borderTop: '1px solid #222222',
    paddingTop: 64,
    paddingBottom: 40,
  },
  top: {
    display: 'grid',
    gridTemplateColumns: '1.5fr 2fr',
    gap: 64,
    alignItems: 'flex-start',
  },
  brand: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  logoText: {
    fontSize: 18,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '-0.3px',
  },
  tagline: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    lineHeight: 1.6,
    maxWidth: 280,
  },
  badges: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  linkCols: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 32,
  },
  linkCol: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  colHeading: {
    fontSize: 12,
    fontWeight: 500,
    color: '#ffffff',
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    marginBottom: 4,
  },
  link: {
    fontSize: 14,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
    textDecoration: 'none',
    transition: 'color 0.15s',
  },
  bottom: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: 16,
  },
  copy: {
    fontSize: 13,
    color: '#9b9b9b',
    letterSpacing: '0.05em',
  },
  bottomLinks: {
    display: 'flex',
    gap: 24,
  },
};
