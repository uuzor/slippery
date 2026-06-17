'use client';

import { useState } from 'react';

import { useZkLogin } from '../lib/zklogin';
import {
  previewConstants,
  previewSlipFromQuotes,
  useOwnedQuoteCoins,
  useOwnedSlipReceipts,
  usePredictMarkets,
  usePredictSelectionQuote,
  useVaultState,
  useProtocolWrites,
  type PredictMarket,
  type PredictQuote,
} from '../lib/protocol';

function formatObjectId(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatDusdc(value: bigint, fractionDigits = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const fraction = abs % 1_000_000n;
  const fractionText = fraction.toString().padStart(6, '0').slice(0, fractionDigits);
  const withSeparators = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (fractionDigits === 0) {
    return `${negative ? '-' : ''}${withSeparators}`;
  }
  return `${negative ? '-' : ''}${withSeparators}.${fractionText}`;
}

function formatOdds(value: bigint): string {
  return formatDusdc(value, 2);
}

function formatBonusPct(multiplier: bigint): string {
  if (multiplier <= previewConstants.floatScaling) {
    return '0.00%';
  }
  const bonusBps = ((multiplier - previewConstants.floatScaling) * 10_000n) / previewConstants.floatScaling;
  const whole = bonusBps / 100n;
  const frac = (bonusBps % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${frac}%`;
}

function formatExpiry(expiry: bigint): string {
  const date = new Date(Number(expiry));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function buildLegKey(leg: { oracleId: string; strike: bigint; isUp: boolean }): string {
  return `${leg.oracleId}:${leg.strike.toString()}:${leg.isUp ? 'up' : 'down'}`;
}

function parseQuantityInput(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
}

function marketDefaultStrike(market: PredictMarket): bigint {
  return market.atmStrike;
}

export default function MarketsClient() {
  const { address, isReady } = useZkLogin();
  const { data: markets, isLoading: isMarketsLoading, error: marketsError, refresh: refreshMarkets } =
    usePredictMarkets('BTC', 8, 2, 0);
  const { data: quoteCoins, refresh: refreshCoins } = useOwnedQuoteCoins(address, 45_000);
  const { data: ownedReceipts, refresh: refreshReceipts } = useOwnedSlipReceipts(address, 45_000);
  const { data: vaultState, refresh: refreshVaultState } = useVaultState(45_000);
  const { quoteFromMarket, isLoading: isQuoting, error: quoteError } = usePredictSelectionQuote();
  const { placeSlip } = useProtocolWrites();

  const [quantityInput, setQuantityInput] = useState('1000000');
  const [selectedLegs, setSelectedLegs] = useState<PredictQuote[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);
  const [isPlacing, setIsPlacing] = useState(false);
  const [activeLegKey, setActiveLegKey] = useState<string | null>(null);

  const quantity = parseQuantityInput(quantityInput);
  const preview = previewSlipFromQuotes(selectedLegs);
  const totalQuoteBalance = (quoteCoins ?? []).reduce((sum, coin) => sum + coin.balance, 0n);
  const selectedLegKeys = new Set(selectedLegs.map((leg) => buildLegKey(leg)));
  const canPlace =
    isReady &&
    selectedLegs.length >= Number(previewConstants.minLegs) &&
    selectedLegs.length <= Number(previewConstants.maxLegs) &&
    preview.requiredStake > 0n &&
    totalQuoteBalance >= preview.requiredStake &&
    !isPlacing;

  async function handleAddLeg(market: PredictMarket, strike: bigint, isUp: boolean) {
    setActionError(null);
    setLastDigest(null);

    if (!quantity) {
      setActionError('Enter a valid positive Predict quantity before adding a leg.');
      return;
    }

    const nextKey = buildLegKey({ oracleId: market.oracleId, strike, isUp });
    const exists = selectedLegs.some((leg) => buildLegKey(leg) === nextKey);
    if (!exists && selectedLegs.length >= Number(previewConstants.maxLegs)) {
      setActionError(`You can place at most ${previewConstants.maxLegs.toString()} legs per slip.`);
      return;
    }

    setActiveLegKey(nextKey);
    try {
      const quoted = await quoteFromMarket({
        market,
        strike,
        isUp,
        quantity,
        sender: address ?? undefined,
      });
      setSelectedLegs((current) => {
        const withoutMatch = current.filter((leg) => buildLegKey(leg) !== nextKey);
        return [...withoutMatch, quoted].sort((left, right) =>
          left.expiry === right.expiry
            ? Number(left.strike - right.strike)
            : Number(left.expiry - right.expiry),
        );
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActiveLegKey(null);
    }
  }

  function handleRemoveLeg(legKey: string) {
    setActionError(null);
    setSelectedLegs((current) => current.filter((leg) => buildLegKey(leg) !== legKey));
  }

  async function handlePlaceSlip() {
    setActionError(null);
    setLastDigest(null);

    if (!isReady) {
      setActionError('Sign in from the navbar before placing a slip.');
      return;
    }
    if (!quoteCoins || quoteCoins.length === 0) {
      setActionError('No dUSDC coin objects available for this wallet.');
      return;
    }
    if (selectedLegs.length < Number(previewConstants.minLegs)) {
      setActionError(`Select at least ${previewConstants.minLegs.toString()} quoted legs.`);
      return;
    }
    if (preview.requiredStake > totalQuoteBalance) {
      setActionError('Insufficient dUSDC balance for the required stake.');
      return;
    }

    setIsPlacing(true);
    try {
      const result = await placeSlip({
        coinObjectIds: quoteCoins.map((coin) => coin.coinObjectId),
        stakeAmount: preview.requiredStake,
        legs: selectedLegs,
      });
      setLastDigest(result.digest);
      setSelectedLegs([]);
      await Promise.all([refreshCoins(), refreshReceipts(), refreshVaultState()]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPlacing(false);
    }
  }

  return (
    <main style={styles.page}>
      <section className="section-sm">
        <div style={styles.shell}>
          <div className="card" style={styles.marketToolbar}>
            <div style={styles.marketToolbarTitle}>
              <div style={styles.marketToolbarHeading}>BTC Predict Markets</div>
              <div style={styles.marketToolbarSubline}>Quote legs and stack the slip you actually want to submit.</div>
            </div>
            <div style={styles.marketToolbarControls}>
              <div style={styles.marketToolbarField}>
                <span style={styles.marketToolbarLabel}>Quantity</span>
                <input
                  value={quantityInput}
                  onChange={(event) => setQuantityInput(event.target.value)}
                  inputMode="numeric"
                  style={styles.quantityInput}
                  placeholder="1000000"
                />
              </div>
              <div style={styles.marketToolbarStat}>
                <span style={styles.marketToolbarLabel}>Required stake</span>
                <strong style={styles.marketToolbarValue}>{formatDusdc(preview.requiredStake)} DUSDC</strong>
              </div>
              <div style={styles.marketToolbarStat}>
                <span style={styles.marketToolbarLabel}>Selected legs</span>
                <strong style={styles.marketToolbarValue}>{selectedLegs.length.toString()}</strong>
              </div>
              <div style={styles.marketToolbarStat}>
                <span style={styles.marketToolbarLabel}>Bonus capacity</span>
                <strong style={styles.marketToolbarValue}>
                  {vaultState ? `${formatDusdc(vaultState.availableBonusCapacity)} DUSDC` : 'Loading...'}
                </strong>
              </div>
            </div>
          </div>

          <div style={styles.workspaceGrid}>
            <div style={styles.marketColumn}>
              <div style={styles.sectionHeader}>
                <div>
                  <span className="tag">Live book</span>
                  <h2 style={styles.sectionTitle}>Choose quoted outcomes</h2>
                </div>
                <button className="btn-ghost" onClick={() => void refreshMarkets()} style={styles.refreshButton}>
                  Refresh markets
                </button>
              </div>

              {marketsError ? (
                <div className="card" style={styles.messageCard}>
                  <span style={styles.errorText}>{marketsError}</span>
                </div>
              ) : null}

              {isMarketsLoading && !markets?.length ? (
                <div className="card" style={styles.messageCard}>Loading Predict markets...</div>
              ) : null}

              <div style={styles.marketList}>
                {(markets ?? []).map((market) => (
                  <div key={market.marketId} className="card" style={styles.marketCard}>
                    <div style={styles.marketCardHeader}>
                      <div style={styles.marketHeaderIdentity}>
                        <div style={styles.marketTitle}>{market.underlyingAsset} oracle</div>
                        <div style={styles.marketSubline}>Oracle {formatObjectId(market.oracleId)}</div>
                      </div>
                      <div style={styles.marketMetaStrip}>
                        <div style={styles.marketMetaChip}>
                          <span style={styles.marketMetaChipLabel}>Expiry</span>
                          <span style={styles.marketMetaChipValue}>{formatExpiry(market.expiry)}</span>
                        </div>
                        <div style={styles.marketMetaChip}>
                          <span style={styles.marketMetaChipLabel}>Forward</span>
                          <span style={styles.marketMetaChipValue}>{formatDusdc(market.forward, 2)}</span>
                        </div>
                        <div style={styles.marketMetaChip}>
                          <span style={styles.marketMetaChipLabel}>ATM</span>
                          <span style={styles.marketMetaChipValue}>{formatDusdc(marketDefaultStrike(market), 2)}</span>
                        </div>
                        <div style={styles.marketMetaChip}>
                          <span style={styles.marketMetaChipLabel}>Tick</span>
                          <span style={styles.marketMetaChipValue}>{formatDusdc(market.tickSize, 2)}</span>
                        </div>
                      </div>
                    </div>

                    <div style={styles.tableHeader}>
                      <span>Strike</span>
                      <span>Distance</span>
                      <span>UP side</span>
                      <span>DOWN side</span>
                    </div>

                    <div style={styles.strikeList}>
                      {market.strikeOptions.map((option) => {
                        const upKey = buildLegKey({ oracleId: market.oracleId, strike: option.strike, isUp: true });
                        const downKey = buildLegKey({ oracleId: market.oracleId, strike: option.strike, isUp: false });
                        const isBusy = activeLegKey === upKey || activeLegKey === downKey;
                        const isUpSelected = selectedLegKeys.has(upKey);
                        const isDownSelected = selectedLegKeys.has(downKey);

                        return (
                          <div
                            key={`${market.marketId}:${option.strike.toString()}`}
                            style={{
                              ...styles.strikeRow,
                              ...(isUpSelected || isDownSelected ? styles.strikeRowActive : null),
                            }}
                          >
                            <div style={styles.strikeColumn}>
                              <div style={styles.strikeValue}>{formatDusdc(option.strike, 2)}</div>
                            </div>
                            <div style={styles.distanceColumn}>
                              <div style={styles.strikeHint}>
                                {option.isAtTheMoney
                                  ? 'ATM'
                                  : `${option.distanceFromAtmSteps.toString()} tick${option.distanceFromAtmSteps === 1n ? '' : 's'} away`}
                              </div>
                            </div>
                            <div style={styles.actionColumn}>
                              <button
                                className="btn-ghost"
                                style={{
                                  ...styles.sideButton,
                                  ...(isUpSelected ? styles.sideButtonSelected : null),
                                }}
                                onClick={() => void handleAddLeg(market, option.strike, true)}
                                disabled={isBusy || !quantity}
                              >
                                {activeLegKey === upKey && isQuoting ? 'Quoting...' : isUpSelected ? 'Selected ✓' : 'Add Up'}
                              </button>
                            </div>
                            <div style={styles.actionColumn}>
                              <button
                                className="btn-ghost"
                                style={{
                                  ...styles.sideButton,
                                  ...(isDownSelected ? styles.sideButtonSelected : null),
                                }}
                                onClick={() => void handleAddLeg(market, option.strike, false)}
                                disabled={isBusy || !quantity}
                              >
                                {activeLegKey === downKey && isQuoting ? 'Quoting...' : isDownSelected ? 'Selected ✓' : 'Add Down'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={styles.builderColumn}>
              <div className="card-mint" style={styles.builderCard}>
                <div style={styles.sectionHeader}>
                  <div>
                    <span className="tag-mint">Slip builder</span>
                    <h2 style={styles.sectionTitle}>Selected quoted legs</h2>
                  </div>
                  <span style={styles.builderCount}>
                    {selectedLegs.length}/{previewConstants.maxLegs.toString()}
                  </span>
                </div>

                <div style={styles.previewGrid}>
                  <div>
                    <div style={styles.metaLabel}>Required stake</div>
                    <div style={styles.previewValue}>{formatDusdc(preview.requiredStake)} DUSDC</div>
                  </div>
                  <div>
                    <div style={styles.metaLabel}>Projected payout</div>
                    <div style={styles.previewValue}>{formatDusdc(preview.potentialPayout)} DUSDC</div>
                  </div>
                  <div>
                    <div style={styles.metaLabel}>Bonus add-on</div>
                    <div style={styles.previewValue}>{formatDusdc(preview.bonusAmount)} DUSDC</div>
                  </div>
                  <div>
                    <div style={styles.metaLabel}>Combined odds</div>
                    <div style={styles.previewValue}>{formatOdds(preview.combinedOdds)}x</div>
                  </div>
                </div>

                <div style={styles.secondaryGrid}>
                  <div style={styles.statLine}>
                    <span style={styles.metaLabel}>Bonus multiplier</span>
                    <span style={styles.metaValue}>{formatBonusPct(preview.bonusMultiplier)}</span>
                  </div>
                  <div style={styles.statLine}>
                    <span style={styles.metaLabel}>Quoted leg subtotal</span>
                    <span style={styles.metaValue}>{formatDusdc(preview.quoteSubtotal)} DUSDC</span>
                  </div>
                  <div style={styles.statLine}>
                    <span style={styles.metaLabel}>Stake buffer</span>
                    <span style={styles.metaValue}>{formatDusdc(previewConstants.stakeBuffer)} DUSDC</span>
                  </div>
                  <div style={styles.statLine}>
                    <span style={styles.metaLabel}>Wallet spendable</span>
                    <span style={styles.metaValue}>{formatDusdc(totalQuoteBalance)} DUSDC</span>
                  </div>
                </div>

                <div style={styles.legList}>
                  {selectedLegs.length === 0 ? (
                    <div style={styles.emptyState}>
                      Click any market side to quote and pin it into the current slip.
                    </div>
                  ) : null}
                  {selectedLegs.map((leg) => {
                    const legKey = buildLegKey(leg);
                    return (
                      <div key={legKey} style={styles.selectedLegCard}>
                        <div>
                          <div style={styles.selectedLegTitle}>
                            {leg.isUp ? 'UP' : 'DOWN'} · strike {formatDusdc(leg.strike, 2)}
                          </div>
                          <div style={styles.selectedLegMeta}>
                            {formatExpiry(leg.expiry)} · qty {leg.quantity.toString()} · oracle {formatObjectId(leg.oracleId)}
                          </div>
                        </div>
                        <div style={styles.selectedLegRight}>
                          <div style={styles.selectedLegPrice}>{formatDusdc(leg.quoteAmount)} DUSDC</div>
                          <button style={styles.removeButton} onClick={() => handleRemoveLeg(legKey)}>
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {quoteError && !actionError ? <div style={styles.errorText}>{quoteError}</div> : null}
                {actionError ? <div style={styles.errorText}>{actionError}</div> : null}
                {lastDigest ? <div style={styles.successText}>Slip submitted. Digest: {lastDigest}</div> : null}

                <button className="btn-primary" style={styles.placeButton} onClick={() => void handlePlaceSlip()} disabled={!canPlace}>
                  {isPlacing ? 'Submitting slip...' : 'Place slip onchain'}
                </button>

                {!isReady ? (
                  <div style={styles.inlineHelp}>Sign in from the navbar before placing a slip.</div>
                ) : null}
                {preview.requiredStake > totalQuoteBalance ? (
                  <div style={styles.inlineHelp}>
                    This wallet needs {formatDusdc(preview.requiredStake - totalQuoteBalance)} more DUSDC to place the current quoted slip.
                  </div>
                ) : null}
              </div>

              <div className="card" style={styles.positionCard}>
                <div style={styles.sectionHeader}>
                  <div>
                    <span className="tag">Your protocol state</span>
                    <h2 style={styles.sectionTitle}>Receipts and vault</h2>
                  </div>
                </div>

                <div style={styles.phaseGrid}>
                  <div style={styles.phaseStat}>
                    <span style={styles.metaLabel}>Receipts</span>
                    <strong style={styles.metaValue}>{ownedReceipts?.length.toString() ?? '0'}</strong>
                  </div>
                  <div style={styles.phaseStat}>
                    <span style={styles.metaLabel}>Epoch</span>
                    <strong style={styles.metaValue}>{vaultState?.currentEpoch.toString() ?? '--'}</strong>
                  </div>
                  <div style={styles.phaseStat}>
                    <span style={styles.metaLabel}>LP balance</span>
                    <strong style={styles.metaValue}>{vaultState ? formatDusdc(vaultState.lpBalance, 0) : '--'}</strong>
                  </div>
                  <div style={styles.phaseStat}>
                    <span style={styles.metaLabel}>Locked bonus</span>
                    <strong style={styles.metaValue}>{vaultState ? formatDusdc(vaultState.lockedBonus, 0) : '--'}</strong>
                  </div>
                </div>

                <div style={styles.receiptList}>
                  {(ownedReceipts ?? []).slice(0, 6).map((receipt) => (
                    <div key={receipt.receiptId} style={styles.receiptCard}>
                      <div style={styles.receiptTop}>
                        <span style={styles.receiptId}>{formatObjectId(receipt.receiptId)}</span>
                        <span className="tag-mint">{receipt.legs.length} legs</span>
                      </div>
                      <div style={styles.receiptRow}>
                        <span style={styles.metaLabel}>Stake</span>
                        <span style={styles.metaValue}>{formatDusdc(receipt.stake)} DUSDC</span>
                      </div>
                      <div style={styles.receiptRow}>
                        <span style={styles.metaLabel}>Potential payout</span>
                        <span style={styles.metaValue}>{formatDusdc(receipt.potentialPayout)} DUSDC</span>
                      </div>
                      <div style={styles.receiptRow}>
                        <span style={styles.metaLabel}>Bonus amount</span>
                        <span style={styles.metaValue}>{formatDusdc(receipt.bonusAmount)} DUSDC</span>
                      </div>
                    </div>
                  ))}
                  {ownedReceipts && ownedReceipts.length === 0 ? (
                    <div style={styles.emptyState}>No owned slip receipts yet.</div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    paddingBottom: 96,
    background:
      'radial-gradient(circle at top left, rgba(63,226,128,0.08), transparent 24%), radial-gradient(circle at top right, rgba(255,255,255,0.06), transparent 20%), #0a0a0a',
  },
  shell: {
    maxWidth: 1560,
    margin: '0 auto',
    padding: '0 24px',
  },
  marketToolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 24,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 24,
  },
  marketToolbarTitle: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  marketToolbarHeading: {
    fontSize: 30,
    lineHeight: 1,
    letterSpacing: '-0.04em',
    color: '#ffffff',
  },
  marketToolbarSubline: {
    color: '#8d8d8d',
    fontSize: 14,
  },
  marketToolbarControls: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
    alignItems: 'stretch',
  },
  marketToolbarField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minWidth: 160,
  },
  marketToolbarStat: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    justifyContent: 'center',
    minWidth: 160,
    padding: '12px 14px',
    borderRadius: 14,
    background: '#121212',
    border: '1px solid #242424',
  },
  marketToolbarLabel: {
    color: '#8d8d8d',
    fontSize: 11,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  marketToolbarValue: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: '-0.02em',
  },
  workspaceGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.8fr) minmax(360px, 0.9fr)',
    gap: 24,
    alignItems: 'start',
  },
  marketColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  builderColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    position: 'sticky',
    top: 88,
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  sectionTitle: {
    marginTop: 8,
    fontSize: 28,
    lineHeight: 1.1,
    letterSpacing: '-0.03em',
  },
  refreshButton: {
    whiteSpace: 'nowrap',
  },
  quantityInput: {
    width: 160,
    background: '#0f0f0f',
    border: '1px solid #2a2a2a',
    borderRadius: 12,
    padding: '12px 14px',
    color: '#ffffff',
    fontSize: 15,
  },
  messageCard: {
    color: '#d1d1d1',
  },
  marketList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  marketCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    padding: 20,
  },
  marketCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  marketHeaderIdentity: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  marketTitle: {
    fontSize: 20,
    fontWeight: 600,
    letterSpacing: '-0.02em',
  },
  marketSubline: {
    color: '#8d8d8d',
    fontSize: 13,
  },
  marketMetaStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))',
    gap: 10,
    flex: 1,
    minWidth: 480,
  },
  marketMetaChip: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 14px',
    borderRadius: 14,
    background: '#111111',
    border: '1px solid #242424',
  },
  marketMetaChipLabel: {
    color: '#8d8d8d',
    fontSize: 11,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  marketMetaChipValue: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 600,
  },
  tableHeader: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 0.8fr) minmax(160px, 1fr) minmax(140px, 0.9fr) minmax(140px, 0.9fr)',
    gap: 12,
    padding: '0 12px',
    color: '#7c7c7c',
    fontSize: 11,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  strikeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  strikeRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 0.8fr) minmax(160px, 1fr) minmax(140px, 0.9fr) minmax(140px, 0.9fr)',
    gap: 12,
    alignItems: 'center',
    padding: '14px 16px',
    borderRadius: 14,
    background: '#121212',
    border: '1px solid #262626',
    transition: 'border-color 0.15s ease, background 0.15s ease',
  },
  strikeRowActive: {
    background: '#101812',
    border: '1px solid rgba(63,226,128,0.4)',
  },
  strikeColumn: {
    minWidth: 0,
  },
  distanceColumn: {
    minWidth: 0,
  },
  actionColumn: {
    minWidth: 0,
  },
  strikeValue: {
    fontSize: 18,
    fontWeight: 600,
    letterSpacing: '-0.02em',
  },
  strikeHint: {
    fontSize: 12,
    color: '#8d8d8d',
  },
  sideButton: {
    width: '100%',
    justifyContent: 'center',
    minHeight: 44,
  },
  sideButtonSelected: {
    background: '#132317',
    border: '1px solid #3fe280',
    color: '#3fe280',
  },
  builderCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  builderCount: {
    color: '#3fe280',
    fontSize: 24,
    fontWeight: 700,
    letterSpacing: '-0.04em',
  },
  previewGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 16,
    padding: 18,
    borderRadius: 18,
    background: 'rgba(9, 22, 14, 0.55)',
    border: '1px solid rgba(63,226,128,0.2)',
  },
  metaLabel: {
    color: '#8d8d8d',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  metaValue: {
    color: '#ffffff',
    marginTop: 4,
    fontSize: 15,
  },
  previewValue: {
    fontSize: 20,
    marginTop: 6,
    letterSpacing: '-0.03em',
  },
  secondaryGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: 10,
  },
  statLine: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
  },
  legList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  emptyState: {
    padding: 16,
    borderRadius: 14,
    background: '#121212',
    border: '1px dashed #2e2e2e',
    color: '#8d8d8d',
    fontSize: 14,
    lineHeight: 1.6,
  },
  selectedLegCard: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 14,
    flexWrap: 'wrap',
    padding: '14px 16px',
    borderRadius: 14,
    background: '#111713',
    border: '1px solid rgba(63,226,128,0.15)',
  },
  selectedLegTitle: {
    fontSize: 16,
    fontWeight: 600,
  },
  selectedLegMeta: {
    marginTop: 6,
    color: '#8d8d8d',
    fontSize: 12,
  },
  selectedLegRight: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    alignItems: 'flex-end',
  },
  selectedLegPrice: {
    fontSize: 16,
    fontWeight: 600,
    color: '#3fe280',
  },
  removeButton: {
    background: 'transparent',
    border: 'none',
    color: '#a5a5a5',
    fontSize: 12,
  },
  errorText: {
    color: '#ff8d8d',
    fontSize: 13,
    lineHeight: 1.5,
  },
  successText: {
    color: '#3fe280',
    fontSize: 13,
    lineHeight: 1.5,
    wordBreak: 'break-all',
  },
  placeButton: {
    width: '100%',
    justifyContent: 'center',
    paddingTop: 14,
    paddingBottom: 14,
  },
  inlineHelp: {
    color: '#8d8d8d',
    fontSize: 13,
    lineHeight: 1.5,
  },
  positionCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  phaseGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: 12,
  },
  phaseStat: {
    padding: 14,
    borderRadius: 14,
    background: '#111111',
    border: '1px solid #242424',
  },
  receiptList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  receiptCard: {
    padding: 14,
    borderRadius: 14,
    background: '#101010',
    border: '1px solid #242424',
  },
  receiptTop: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  receiptId: {
    fontFamily: 'monospace',
    fontSize: 13,
    color: '#d7d7d7',
  },
  receiptRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    marginTop: 8,
  },
};
