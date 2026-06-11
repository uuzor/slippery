'use client';

import { useState } from 'react';

// Mock data for markets
const mockMarkets = [
  { id: '1', name: 'BTC > $70k by Friday', odds: 1.45, expiry: '2h 30m' },
  { id: '2', name: 'ETH breaks $4k this week', odds: 1.68, expiry: '5h' },
  { id: '3', name: 'SUI > $2.50 by weekend', odds: 1.82, expiry: '3d' },
  { id: '4', name: 'Solana DEX volume > $5B', odds: 1.55, expiry: '1d' },
];

// Illustration characters as SVG
const Characters = {
  Orange: () => (
    <svg viewBox="0 0 100 100" style={{ width: 80, height: 80 }}>
      <ellipse cx="50" cy="55" rx="40" ry="35" fill="#ff3e00" />
      <circle cx="35" cy="50" r="6" fill="#fff" />
      <circle cx="65" cy="50" r="6" fill="#fff" />
      <circle cx="35" cy="50" r="3" fill="#121212" />
      <circle cx="65" cy="50" r="3" fill="#121212" />
      <path d="M 35 70 Q 50 80 65 70" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
      <rect x="45" y="10" width="10" height="25" fill="#ff3e00" />
      <ellipse cx="50" cy="10" rx="15" ry="8" fill="#ff3e00" />
    </svg>
  ),
  Green: () => (
    <svg viewBox="0 0 100 100" style={{ width: 100, height: 100 }}>
      <ellipse cx="50" cy="50" rx="45" ry="40" fill="#00ca48" />
      <circle cx="30" cy="45" r="8" fill="#fff" />
      <circle cx="70" cy="45" r="8" fill="#fff" />
      <circle cx="30" cy="45" r="4" fill="#121212" />
      <circle cx="70" cy="45" r="4" fill="#121212" />
      <path d="M 30 65 Q 50 75 70 65" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
      <rect x="20" y="85" width="8" height="20" fill="#00ca48" rx="4" />
      <rect x="72" y="85" width="8" height="20" fill="#00ca48" rx="4" />
    </svg>
  ),
  Blue: () => (
    <svg viewBox="0 0 100 100" style={{ width: 70, height: 70 }}>
      <circle cx="50" cy="50" r="40" fill="#0090ff" />
      <circle cx="35" cy="45" r="7" fill="#fff" />
      <circle cx="65" cy="45" r="7" fill="#fff" />
      <circle cx="35" cy="45" r="3" fill="#121212" />
      <circle cx="65" cy="45" r="3" fill="#121212" />
      <path d="M 30 60 Q 50 72 70 60" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="25" cy="30" r="8" fill="#64c6ff" />
      <circle cx="75" cy="30" r="8" fill="#64c6ff" />
    </svg>
  ),
  Yellow: () => (
    <svg viewBox="0 0 100 100" style={{ width: 90, height: 90 }}>
      <ellipse cx="50" cy="55" rx="38" ry="35" fill="#ffbb26" />
      <circle cx="35" cy="48" r="6" fill="#fff" />
      <circle cx="65" cy="48" r="6" fill="#fff" />
      <circle cx="35" cy="48" r="3" fill="#121212" />
      <circle cx="65" cy="48" r="3" fill="#121212" />
      <path d="M 40 68 L 50 75 L 60 68" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 45 20 L 50 5 L 55 20 Z" fill="#d48f00" />
      <path d="M 30 15 L 40 10 L 38 25 Z" fill="#d48f00" />
      <path d="M 70 15 L 60 10 L 62 25 Z" fill="#d48f00" />
    </svg>
  ),
};

export default function Home() {
  const [selectedLegs, setSelectedLegs] = useState<string[]>([]);
  const [stakeAmount, setStakeAmount] = useState('100');
  const [activeTab, setActiveTab] = useState<'bet' | 'vault'>('bet');

  const toggleLeg = (id: string) => {
    if (selectedLegs.includes(id)) {
      setSelectedLegs(selectedLegs.filter(l => l !== id));
    } else if (selectedLegs.length < 4) {
      setSelectedLegs([...selectedLegs, id]);
    }
  };

  const calculateCombinedOdds = () => {
    if (selectedLegs.length < 2) return 0;
    let odds = 1;
    selectedLegs.forEach(id => {
      const market = mockMarkets.find(m => m.id === id);
      if (market) odds *= market.odds;
    });
    // Apply 3% house margin
    odds *= 0.97;
    // Apply bonus multiplier
    if (selectedLegs.length === 3) odds *= 1.05;
    if (selectedLegs.length === 4) odds *= 1.10;
    return odds;
  };

  const combinedOdds = calculateCombinedOdds();
  const potentialPayout = (parseFloat(stakeAmount) * combinedOdds).toFixed(2);

  return (
    <main>
      {/* Navigation */}
      <nav className="nav">
        <div className="container nav-content">
          <div className="nav-logo">
            <span className="logo-icon">🎰</span>
            <span className="logo-text">Parlay Vault</span>
          </div>
          <div className="nav-links">
            <a href="#markets" className="nav-link">Markets</a>
            <a href="#vault" className="nav-link">LP Vault</a>
            <a href="#docs" className="nav-link">Docs</a>
          </div>
          <div className="nav-actions">
            <button className="btn-secondary">Connect Wallet</button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-characters">
          <div className="character character-1 animate-float" style={{ animationDelay: '0s' }}>
            <Characters.Orange />
          </div>
          <div className="character character-2 animate-float" style={{ animationDelay: '1s' }}>
            <Characters.Green />
          </div>
          <div className="character character-3 animate-float" style={{ animationDelay: '2s' }}>
            <Characters.Blue />
          </div>
          <div className="character character-4 animate-float" style={{ animationDelay: '0.5s' }}>
            <Characters.Yellow />
          </div>
        </div>
        <div className="container hero-content stagger-children">
          <h1 className="font-display hero-title">
            Parlay on<br />
            <span className="text-accent">DeepBook Predict</span>
          </h1>
          <p className="font-body hero-subtitle">
            Combine 2-4 prediction markets. Get correct joint probability odds. 
            Win big with bonus multipliers. LPs earn yield from PLP + losing slips.
          </p>
          <div className="hero-buttons">
            <button className="btn-primary">Start Betting</button>
            <button className="btn-secondary">Learn More</button>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="section stats-section">
        <div className="container">
          <div className="grid-3 stagger-children">
            <div className="card stat-card">
              <div className="stat-value">$2.4M</div>
              <div className="stat-label">Total Volume</div>
            </div>
            <div className="card stat-card">
              <div className="stat-value">847</div>
              <div className="stat-label">Active Bettors</div>
            </div>
            <div className="card stat-card">
              <div className="stat-value">12.4%</div>
              <div className="stat-label">LP Annual Yield</div>
            </div>
          </div>
        </div>
      </section>

      {/* Main Interface */}
      <section className="section interface-section">
        <div className="container">
          {/* Tab Switcher */}
          <div className="tab-switcher">
            <button 
              className={`tab-btn ${activeTab === 'bet' ? 'active' : ''}`}
              onClick={() => setActiveTab('bet')}
            >
              🎯 Place Bet
            </button>
            <button 
              className={`tab-btn ${activeTab === 'vault' ? 'active' : ''}`}
              onClick={() => setActiveTab('vault')}
            >
              💰 LP Vault
            </button>
          </div>

          {/* Betting Interface */}
          {activeTab === 'bet' && (
            <div className="betting-interface">
              <div className="markets-grid stagger-children">
                {mockMarkets.map((market) => (
                  <div 
                    key={market.id}
                    className={`market-card card ${selectedLegs.includes(market.id) ? 'selected' : ''}`}
                    onClick={() => toggleLeg(market.id)}
                  >
                    <div className="market-header">
                      <span className="market-odds">{market.odds.toFixed(2)}x</span>
                      <span className="market-expiry text-muted">{market.expiry}</span>
                    </div>
                    <div className="market-name font-heading-sm">{market.name}</div>
                    {selectedLegs.includes(market.id) && (
                      <div className="market-check">
                        <span>✓</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Combined Odds Display */}
              {selectedLegs.length >= 2 && (
                <div className="combined-odds card animate-slide-up">
                  <div className="odds-header">
                    <span className="font-heading-sm">Combined Odds</span>
                    <span className="bonus-badge">+{selectedLegs.length === 3 ? '5%' : selectedLegs.length === 4 ? '10%' : '0%'} Bonus</span>
                  </div>
                  <div className="odds-value">{combinedOdds.toFixed(2)}x</div>
                  <div className="odds-breakdown">
                    <span className="text-muted">House edge: 3%</span>
                  </div>
                </div>
              )}

              {/* Stake Input */}
              <div className="stake-section">
                <label className="font-heading-sm stake-label">Your Stake (dUSDC)</label>
                <input 
                  type="number" 
                  className="input stake-input"
                  value={stakeAmount}
                  onChange={(e) => setStakeAmount(e.target.value)}
                  min="1"
                  step="1"
                />
              </div>

              {/* Payout Preview */}
              {selectedLegs.length >= 2 && (
                <div className="payout-preview card-warm">
                  <div className="payout-row">
                    <span className="text-muted">Potential Payout</span>
                    <span className="payout-value">{potentialPayout} dUSDC</span>
                  </div>
                  <div className="payout-row">
                    <span className="text-muted">Your Profit</span>
                    <span className="profit-value text-success">
                      +{(parseFloat(potentialPayout) - parseFloat(stakeAmount)).toFixed(2)} dUSDC
                    </span>
                  </div>
                </div>
              )}

              {/* Place Bet Button */}
              <button 
                className="btn-primary place-bet-btn"
                disabled={selectedLegs.length < 2}
              >
                {selectedLegs.length < 2 
                  ? `Select ${2 - selectedLegs.length} more market${2 - selectedLegs.length > 1 ? 's' : ''}`
                  : 'Place Parlay Bet'
                }
              </button>
            </div>
          )}

          {/* LP Vault Interface */}
          {activeTab === 'vault' && (
            <div className="vault-interface">
              <div className="vault-info card">
                <h2 className="font-heading">LP Vault Overview</h2>
                <p className="font-body text-muted" style={{ marginTop: '12px' }}>
                  Deposit dUSDC into the vault to earn yield from two sources:
                </p>
                <div className="yield-sources">
                  <div className="yield-source">
                    <span className="badge badge-green">1</span>
                    <div>
                      <div className="font-heading-sm">DeepBook PLP Yield</div>
                      <div className="text-muted font-caption">Baseline yield from supplying liquidity</div>
                    </div>
                  </div>
                  <div className="yield-source">
                    <span className="badge badge-orange">2</span>
                    <div>
                      <div className="font-heading-sm">Losing Slip Stakes</div>
                      <div className="text-muted font-caption">Earn from bettors who don't win their parlays</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="vault-stats">
                <div className="card vault-stat">
                  <div className="stat-label">Current APY</div>
                  <div className="stat-value text-success">12.4%</div>
                </div>
                <div className="card vault-stat">
                  <div className="stat-label">Your Deposit</div>
                  <div className="stat-value">0 dUSDC</div>
                </div>
                <div className="card vault-stat">
                  <div className="stat-label">Share Price</div>
                  <div className="stat-value">1.000</div>
                </div>
              </div>

              <div className="vault-deposit">
                <label className="font-heading-sm">Deposit dUSDC</label>
                <div className="deposit-row">
                  <input 
                    type="number" 
                    className="input"
                    placeholder="Amount to deposit"
                    min="1"
                  />
                  <button className="btn-primary">Deposit</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* How It Works Section */}
      <section className="section how-section">
        <div className="container">
          <h2 className="font-heading-lg section-title">How It Works</h2>
          <div className="grid-3 stagger-children" style={{ marginTop: '48px' }}>
            <div className="card how-card">
              <div className="how-number">01</div>
              <h3 className="font-heading-sm">Pick Your Markets</h3>
              <p className="font-body text-muted">
                Select 2-4 prediction markets from DeepBook Predict. 
                Each market has its own odds based on the probability of the outcome.
              </p>
            </div>
            <div className="card how-card">
              <div className="how-number">02</div>
              <h3 className="font-heading-sm">Get Fair Odds</h3>
              <p className="font-body text-muted">
                We calculate combined odds using correct joint probability — not naive multiplication.
                Plus, earn bonus multipliers for multi-leg parlays.
              </p>
            </div>
            <div className="card how-card">
              <div className="how-number">03</div>
              <h3 className="font-heading-sm">Win or LP Earns</h3>
              <p className="font-body text-muted">
                If all your legs win, you get the payout. If any leg loses, 
                the stake stays in the vault — LPs earn it as extra yield.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="container footer-content">
          <div className="footer-brand">
            <span className="logo-icon">🎰</span>
            <span className="logo-text">Parlay Vault</span>
          </div>
          <div className="footer-links">
            <a href="#">Documentation</a>
            <a href="#">DeepBook Predict</a>
            <a href="#">Sui Network</a>
          </div>
          <div className="footer-copy">
            <span className="text-muted">Built for Sui Overflow 2026</span>
          </div>
        </div>
      </footer>

      <style jsx>{`
        /* Navigation */
        .nav {
          position: sticky;
          top: 0;
          background: var(--color-warm-canvas);
          box-shadow: var(--shadow-nav);
          height: 64px;
          z-index: 100;
        }
        .nav-content {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 100%;
        }
        .nav-logo {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .logo-icon {
          font-size: 24px;
        }
        .logo-text {
          font-family: var(--font-family);
          font-size: 20px;
          font-weight: 500;
          color: var(--color-charcoal-primary);
          letter-spacing: -0.44px;
        }
        .nav-links {
          display: flex;
          gap: 32px;
        }
        .nav-link {
          font-family: var(--font-inter);
          font-size: 14px;
          font-weight: 500;
          color: var(--color-charcoal-primary);
          text-decoration: none;
          transition: color 0.2s ease;
        }
        .nav-link:hover {
          color: var(--color-ember-orange);
        }
        .nav-actions {
          display: flex;
          gap: 12px;
        }

        /* Hero */
        .hero {
          position: relative;
          min-height: 70vh;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          padding: 120px 0;
        }
        .hero-characters {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }
        .character {
          position: absolute;
          opacity: 0.8;
        }
        .character-1 { top: 15%; left: 5%; }
        .character-2 { top: 20%; right: 8%; }
        .character-3 { bottom: 25%; left: 12%; }
        .character-4 { bottom: 20%; right: 15%; }
        .hero-content {
          text-align: center;
          position: relative;
          z-index: 1;
        }
        .hero-title {
          margin-bottom: 24px;
        }
        .hero-subtitle {
          max-width: 480px;
          margin: 0 auto 32px;
          font-size: 17px;
          letter-spacing: -0.22px;
        }
        .hero-buttons {
          display: flex;
          gap: 12px;
          justify-content: center;
        }

        /* Stats */
        .stats-section {
          padding-top: 0;
        }
        .stat-card {
          text-align: center;
        }
        .stat-value {
          font-family: var(--font-family);
          font-size: 36px;
          font-weight: 500;
          color: var(--color-charcoal-primary);
          letter-spacing: -0.88px;
          margin-bottom: 8px;
        }
        .stat-label {
          font-size: 14px;
          color: var(--color-ash);
          font-weight: 500;
        }

        /* Interface */
        .tab-switcher {
          display: flex;
          gap: 8px;
          margin-bottom: 32px;
          background: var(--color-stone-surface);
          padding: 4px;
          border-radius: var(--radius-pill);
          width: fit-content;
        }
        .tab-btn {
          font-family: var(--font-inter);
          font-size: 14px;
          font-weight: 500;
          padding: 12px 24px;
          border-radius: 28px;
          border: none;
          background: transparent;
          color: var(--color-ash);
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .tab-btn.active {
          background: #ffffff;
          color: var(--color-charcoal-primary);
          box-shadow: var(--shadow-sm);
        }
        .markets-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 16px;
          margin-bottom: 24px;
        }
        @media (max-width: 768px) {
          .markets-grid {
            grid-template-columns: 1fr;
          }
        }
        .market-card {
          cursor: pointer;
          position: relative;
          transition: all 0.2s ease;
          padding: 20px;
        }
        .market-card:hover {
          transform: translateY(-2px);
        }
        .market-card.selected {
          border: 2px solid var(--color-ember-orange);
        }
        .market-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .market-odds {
          font-family: var(--font-family);
          font-size: 24px;
          font-weight: 500;
          color: var(--color-meadow-green);
        }
        .market-expiry {
          font-size: 12px;
        }
        .market-name {
          font-size: 15px;
        }
        .market-check {
          position: absolute;
          top: 12px;
          right: 12px;
          width: 24px;
          height: 24px;
          background: var(--color-ember-orange);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 14px;
        }
        .combined-odds {
          margin-bottom: 24px;
          text-align: center;
        }
        .odds-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .bonus-badge {
          background: var(--color-sunburst-yellow);
          color: var(--color-pepper);
          font-size: 12px;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: var(--radius-md);
        }
        .odds-value {
          font-family: var(--font-family);
          font-size: 48px;
          font-weight: 500;
          color: var(--color-charcoal-primary);
          letter-spacing: -1.14px;
        }
        .odds-breakdown {
          margin-top: 8px;
          font-size: 13px;
        }
        .stake-section {
          margin-bottom: 24px;
        }
        .stake-label {
          display: block;
          margin-bottom: 8px;
        }
        .stake-input {
          font-size: 20px;
          padding: 20px;
        }
        .payout-preview {
          margin-bottom: 24px;
          padding: 20px;
        }
        .payout-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
        }
        .payout-value {
          font-family: var(--font-family);
          font-size: 24px;
          font-weight: 500;
          color: var(--color-charcoal-primary);
        }
        .profit-value {
          font-family: var(--font-inter);
          font-size: 18px;
          font-weight: 600;
        }
        .place-bet-btn {
          width: 100%;
          height: 56px;
          font-size: 16px;
        }
        .place-bet-btn:disabled {
          background: var(--color-fog);
          cursor: not-allowed;
        }

        /* Vault */
        .vault-info {
          margin-bottom: 24px;
        }
        .yield-sources {
          display: flex;
          flex-direction: column;
          gap: 16px;
          margin-top: 20px;
        }
        .yield-source {
          display: flex;
          gap: 16px;
          align-items: flex-start;
        }
        .vault-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-bottom: 24px;
        }
        .vault-stat {
          text-align: center;
        }
        .vault-deposit label {
          display: block;
          margin-bottom: 8px;
        }
        .deposit-row {
          display: flex;
          gap: 12px;
        }
        .deposit-row .input {
          flex: 1;
        }

        /* How It Works */
        .section-title {
          text-align: center;
        }
        .how-card {
          position: relative;
        }
        .how-number {
          font-family: var(--font-family);
          font-size: 48px;
          font-weight: 500;
          color: var(--color-stone-surface);
          letter-spacing: -1.14px;
          margin-bottom: 16px;
        }

        /* Footer */
        .footer {
          padding: 48px 0;
          border-top: 1px solid var(--color-stone-surface);
        }
        .footer-content {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .footer-brand {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .footer-links {
          display: flex;
          gap: 24px;
        }
        .footer-links a {
          color: var(--color-ash);
          text-decoration: none;
          font-size: 14px;
          transition: color 0.2s ease;
        }
        .footer-links a:hover {
          color: var(--color-ember-orange);
        }
        .footer-copy {
          font-size: 12px;
        }

        @media (max-width: 768px) {
          .nav-links {
            display: none;
          }
          .footer-content {
            flex-direction: column;
            gap: 24px;
            text-align: center;
          }
          .vault-stats {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}