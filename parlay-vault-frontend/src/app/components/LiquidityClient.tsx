'use client';

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

import {
  useOwnedLpShares,
  useOwnedQuoteCoins,
  useProtocolWrites,
  useVaultState,
  type LPPosition,
} from '../lib/protocol';
import styles from './LiquidityClient.module.css';

const TOKEN_SCALE = 1_000_000n;

function shortId(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatDusdc(value: bigint, digits = 2): string {
  const whole = value / TOKEN_SCALE;
  const fraction = (value % TOKEN_SCALE).toString().padStart(6, '0').slice(0, digits);
  return digits === 0 ? whole.toLocaleString() : `${whole.toLocaleString()}.${fraction}`;
}

function formatSharePrice(value: bigint): string {
  return `${formatDusdc(value, 4)} DUSDC`;
}

function parseAmount(value: string): bigint | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!/^\d*(\.\d{0,6})?$/.test(normalized) || normalized === '' || normalized === '.') {
    return null;
  }
  const [whole = '0', fraction = ''] = normalized.split('.');
  const amount = BigInt(whole || '0') * TOKEN_SCALE
    + BigInt(fraction.padEnd(6, '0') || '0');
  return amount > 0n ? amount : null;
}

function positionStatus(position: LPPosition, currentEpoch: bigint) {
  if (!position.isActive) {
    return { label: `Queued for epoch ${position.activationEpoch}`, className: styles.statusQueued };
  }
  if (position.activationEpoch >= currentEpoch) {
    return { label: `Locked in epoch ${position.activationEpoch}`, className: styles.statusLocked };
  }
  if (position.unsettledSlipCount > 0n) {
    return { label: `${position.unsettledSlipCount} slips settling`, className: styles.statusLocked };
  }
  return { label: 'Ready to withdraw', className: styles.statusReady };
}

export default function LiquidityClient() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const [amountInput, setAmountInput] = useState('');
  const [autoRoll, setAutoRoll] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const { data: vault, isLoading: vaultLoading, error: vaultError, refresh: refreshVault } = useVaultState(30_000);
  const { data: positions, isLoading: positionsLoading, refresh: refreshPositions } = useOwnedLpShares(address, 30_000);
  const { data: quoteCoins, refresh: refreshCoins } = useOwnedQuoteCoins(address, 30_000);
  const {
    deposit,
    withdraw,
    cancelQueuedDeposit,
    rollOver,
    advanceEpoch,
  } = useProtocolWrites();

  const walletBalance = (quoteCoins ?? []).reduce((sum, coin) => sum + coin.balance, 0n);
  const amount = parseAmount(amountInput);
  const nextEpoch = (vault?.currentEpoch ?? 0n) + 1n;
  const estimatedShares = amount && vault?.sharePrice
    ? (amount * TOKEN_SCALE) / vault.sharePrice
    : 0n;
  const canDeposit = Boolean(
    address
    && amount
    && amount >= TOKEN_SCALE
    && amount <= walletBalance
    && quoteCoins?.length
    && !busyAction,
  );
  const canAdvanceEpoch = Boolean(
    vault
    && vault.chainEpoch > vault.currentEpoch
    && vault.currentEpochSlipCount === 0n
    && !busyAction,
  );
  const totalPositionValue = (positions ?? []).reduce((sum, position) => sum + position.estimatedValue, 0n);
  const activePositionCount = (positions ?? []).filter((position) => position.isActive).length;
  const lockedBonusPct = vault && vault.bonusReserve > 0n
    ? (vault.lockedBonus * 10_000n) / vault.bonusReserve
    : 0n;

  async function refreshAll() {
    await Promise.all([refreshVault(), refreshPositions(), refreshCoins()]);
  }

  async function handleDeposit() {
    setMessage(null);
    if (!amount || !quoteCoins?.length) {
      setMessage({ kind: 'error', text: 'Enter a valid deposit amount.' });
      return;
    }
    setBusyAction('deposit');
    try {
      const result = await deposit({
        coinObjectIds: quoteCoins.map((coin) => coin.coinObjectId),
        amount,
        autoRoll,
      });
      setAmountInput('');
      setMessage({
        kind: 'success',
        text: `Deposit queued for epoch ${nextEpoch}: ${result.digest}`,
      });
      await refreshAll();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePositionAction(
    action: 'withdraw' | 'cancel' | 'roll',
    position: LPPosition,
  ) {
    setMessage(null);
    setBusyAction(`${action}:${position.shareId}`);
    try {
      const result = action === 'withdraw'
        ? await withdraw({ shareId: position.shareId })
        : action === 'cancel'
          ? await cancelQueuedDeposit({ shareId: position.shareId })
          : await rollOver({ shareId: position.shareId });
      setMessage({
        kind: 'success',
        text: `${action === 'withdraw' ? 'Withdrawal' : action === 'cancel' ? 'Queued deposit cancellation' : 'Rollover'} submitted: ${result.digest}`,
      });
      await refreshAll();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAdvanceEpoch() {
    setMessage(null);
    setBusyAction('advance');
    try {
      const result = await advanceEpoch();
      setMessage({ kind: 'success', text: `Vault epoch advanced: ${result.digest}` });
      await refreshAll();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.ticker}>
          <div className={styles.tickerLead}>
            <div className={styles.eyebrow}>Parlay Vault / LP desk</div>
            <div className={styles.tickerTitle}>Underwrite bonuses by epoch</div>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>Vault liquidity</span>
            <strong className={styles.tickerValue}>{vault ? `${formatDusdc(vault.lpBalance)} DUSDC` : '--'}</strong>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>Share price</span>
            <strong className={styles.tickerValue}>{vault ? formatSharePrice(vault.sharePrice) : '--'}</strong>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>Current epoch</span>
            <strong className={styles.tickerValue}>{vault?.currentEpoch.toString() ?? '--'}</strong>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>Your LP value</span>
            <strong className={styles.tickerValue}>{formatDusdc(totalPositionValue)} DUSDC</strong>
          </div>
        </section>

        <div className={styles.workspace}>
          <div className={styles.mainColumn}>
            <section className={styles.panel}>
              <header className={styles.panelHeader}>
                <div>
                  <h1 className={styles.panelTitle}>Vault overview</h1>
                  <p className={styles.panelSubline}>Liquidity enters next epoch and remains locked until that epoch has advanced and all its slips settle.</p>
                </div>
                <button className={styles.refresh} onClick={() => void refreshAll()}>Refresh state</button>
              </header>

              <div className={styles.overviewGrid}>
                <div className={styles.overviewStat}>
                  <span className={styles.label}>Total deposits</span>
                  <div className={styles.overviewValue}>{vault ? formatDusdc(vault.totalDeposits) : '--'}</div>
                  <div className={styles.overviewHint}>LP principal tracked by the vault</div>
                </div>
                <div className={styles.overviewStat}>
                  <span className={styles.label}>Bonus reserve</span>
                  <div className={styles.overviewValue}>{vault ? formatDusdc(vault.bonusReserve) : '--'}</div>
                  <div className={styles.overviewHint}>{vault ? `${formatDusdc(vault.lockedBonus)} currently committed` : 'Loading commitments'}</div>
                </div>
                <div className={styles.overviewStat}>
                  <span className={styles.label}>Reserve utilization</span>
                  <div className={styles.overviewValue}>{`${lockedBonusPct / 100n}.${(lockedBonusPct % 100n).toString().padStart(2, '0')}%`}</div>
                  <div className={styles.overviewHint}>Locked bonus relative to reserve</div>
                </div>
                <div className={styles.overviewStat}>
                  <span className={styles.label}>Your positions</span>
                  <div className={styles.overviewValue}>{positions?.length ?? 0}</div>
                  <div className={styles.overviewHint}>{activePositionCount} active in vault epochs</div>
                </div>
              </div>

              <div className={styles.epochBar}>
                <div className={styles.epochTrack}>
                  <div className={styles.epochNode}>Epoch {vault ? vault.currentEpoch - 1n : '--'}<br />unlocked</div>
                  <span className={styles.epochLine} />
                  <div className={`${styles.epochNode} ${styles.epochCurrent}`}>Epoch {vault?.currentEpoch.toString() ?? '--'}<br />live</div>
                  <span className={styles.epochLine} />
                  <div className={styles.epochNode}>Epoch {nextEpoch.toString()}<br />deposit queue</div>
                </div>
                <div className={styles.epochStatus}>
                  <span className={styles.label}>Epoch state</span>
                  <strong>
                    {!vault
                      ? 'Loading'
                      : vault.currentEpochSlipCount > 0n
                        ? `${vault.currentEpochSlipCount} active slips remain`
                        : vault.chainEpoch > vault.currentEpoch
                          ? 'Ready to advance'
                          : 'Waiting for next Sui epoch'}
                  </strong>
                  {canAdvanceEpoch ? (
                    <button className={styles.buttonPrimary} onClick={() => void handleAdvanceEpoch()} disabled={busyAction === 'advance'}>
                      {busyAction === 'advance' ? 'Advancing...' : 'Advance vault epoch'}
                    </button>
                  ) : null}
                </div>
              </div>
            </section>

            <section className={styles.panel}>
              <header className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Your LP positions</h2>
                  <p className={styles.panelSubline}>Every LPShare is an owned Sui object with its own activation epoch and withdrawal state.</p>
                </div>
              </header>

              <div className={styles.positionList}>
                {(positions ?? []).map((position) => {
                  const status = positionStatus(position, vault?.currentEpoch ?? 0n);
                  const withdrawable = Boolean(
                    vault
                    && position.isActive
                    && position.activationEpoch < vault.currentEpoch
                    && position.unsettledSlipCount === 0n
                    && position.shares > 0n,
                  );
                  const actionKey = busyAction?.endsWith(position.shareId);
                  return (
                    <article className={styles.position} key={position.shareId}>
                      <div className={styles.positionIdentity}>
                        <div className={styles.positionId}>{shortId(position.shareId)}</div>
                        <div className={styles.positionName}>Epoch {position.activationEpoch} LP position</div>
                        <span className={`${styles.status} ${status.className}`}>{status.label}</span>
                      </div>
                      <div className={styles.positionMetric}>
                        <span className={styles.label}>Principal</span>
                        <strong>{formatDusdc(position.principal)} DUSDC</strong>
                      </div>
                      <div className={styles.positionMetric}>
                        <span className={styles.label}>Current value</span>
                        <strong>{formatDusdc(position.estimatedValue)} DUSDC</strong>
                      </div>
                      <div className={styles.positionMetric}>
                        <span className={styles.label}>Shares</span>
                        <strong>{formatDusdc(position.shares, 4)}</strong>
                      </div>
                      <div className={styles.positionMetric}>
                        <span className={styles.label}>Rollover flag</span>
                        <strong>{position.autoRoll ? 'Enabled' : 'Manual'}</strong>
                      </div>
                      <div className={styles.actions}>
                        {!position.isActive ? (
                          <button className={styles.buttonDanger} disabled={actionKey} onClick={() => void handlePositionAction('cancel', position)}>
                            {busyAction === `cancel:${position.shareId}` ? 'Cancelling...' : 'Cancel deposit'}
                          </button>
                        ) : (
                          <>
                            <button className={styles.button} disabled={!withdrawable || actionKey} onClick={() => void handlePositionAction('withdraw', position)}>
                              {busyAction === `withdraw:${position.shareId}` ? 'Withdrawing...' : 'Withdraw'}
                            </button>
                            <button className={styles.buttonPrimary} disabled={!withdrawable || actionKey} onClick={() => void handlePositionAction('roll', position)}>
                              {busyAction === `roll:${position.shareId}` ? 'Rolling...' : 'Roll to next epoch'}
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
                {positionsLoading ? <div className={styles.empty}>Loading your LPShare objects...</div> : null}
                {!positionsLoading && address && positions?.length === 0 ? <div className={styles.empty}>No LP positions yet. Queue liquidity from the deposit panel.</div> : null}
                {!address ? <div className={styles.empty}>Connect your wallet to view and manage LP positions.</div> : null}
              </div>
            </section>
          </div>

          <aside className={styles.rail}>
            <section className={styles.panel}>
              <header className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Queue liquidity</h2>
                  <p className={styles.panelSubline}>Activates at epoch {nextEpoch.toString()}</p>
                </div>
              </header>
              <div className={styles.depositBody}>
                <div className={styles.amountBox}>
                  <div className={styles.amountHeader}>
                    <span className={styles.label}>Deposit amount</span>
                    <button className={styles.maxButton} onClick={() => setAmountInput(formatDusdc(walletBalance, 6))}>Use max</button>
                  </div>
                  <div className={styles.inputRow}>
                    <input
                      className={styles.input}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amountInput}
                      onChange={(event) => setAmountInput(event.target.value)}
                    />
                    <span className={styles.token}>DUSDC</span>
                  </div>
                </div>

                <div className={styles.depositPreview}>
                  <div className={styles.row}><span>Wallet balance</span><strong>{formatDusdc(walletBalance)} DUSDC</strong></div>
                  <div className={styles.row}><span>Entry epoch</span><strong>{nextEpoch.toString()}</strong></div>
                  <div className={styles.row}><span>Entry share price</span><strong>Set when epoch advances</strong></div>
                  <div className={styles.row}><span>Estimated shares</span><strong>{formatDusdc(estimatedShares, 4)}</strong></div>
                  <div className={styles.row}><span>Earliest withdrawal</span><strong>After epoch {nextEpoch.toString()} settles</strong></div>
                </div>

                <label className={styles.checkRow}>
                  <input type="checkbox" checked={autoRoll} onChange={(event) => setAutoRoll(event.target.checked)} />
                  <span>Mark this position for rollover. Rollover still requires an on-chain `roll_over` transaction after the position unlocks.</span>
                </label>

                {message ? (
                  <div className={`${styles.message} ${message.kind === 'error' ? styles.error : styles.success}`} aria-live="polite">
                    {message.text}
                  </div>
                ) : null}
                {vaultError ? <div className={`${styles.message} ${styles.error}`}>{vaultError}</div> : null}

                <button className={styles.submit} disabled={!canDeposit} onClick={() => void handleDeposit()}>
                  {busyAction === 'deposit'
                    ? 'Queueing deposit...'
                    : !address
                      ? 'Connect wallet to deposit'
                      : !amount || amount < TOKEN_SCALE
                        ? 'Minimum deposit is 1 DUSDC'
                        : amount > walletBalance
                          ? 'Insufficient DUSDC'
                          : `Queue for epoch ${nextEpoch}`}
                </button>
              </div>
            </section>

            <section className={styles.panel}>
              <header className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Epoch rules</h2>
                  <p className={styles.panelSubline}>The contract enforces every lock below.</p>
                </div>
              </header>
              <div className={styles.infoBody}>
                <div className={styles.riskList}>
                  <div className={styles.riskItem}><span className={styles.riskNumber}>1</span><span>Deposits queue for the next vault epoch. They can be cancelled until activation.</span></div>
                  <div className={styles.riskItem}><span className={styles.riskNumber}>2</span><span>Shares activate at the epoch-start share price and become exposed to that epoch&apos;s slips.</span></div>
                  <div className={styles.riskItem}><span className={styles.riskNumber}>3</span><span>Withdrawal stays disabled until the vault advances beyond the activation epoch and its unsettled slip count reaches zero.</span></div>
                  <div className={styles.riskItem}><span className={styles.riskNumber}>4</span><span>At unlock, withdraw to DUSDC or roll the current position value into the next epoch.</span></div>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
