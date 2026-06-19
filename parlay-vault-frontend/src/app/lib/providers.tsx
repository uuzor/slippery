'use client';

import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
  useSuiClientContext,
} from '@mysten/dapp-kit';
import { isEnokiNetwork, registerEnokiWallets } from '@mysten/enoki';
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

// Network config — Enoki wallets are network-bound, so this single source of
// truth drives both the JSON-RPC client and the wallet registration.
const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' },
  mainnet: { url: getJsonRpcFullnodeUrl('mainnet'), network: 'mainnet' },
});

const DEFAULT_NETWORK = 'testnet';

// Register Enoki wallets for every supported auth provider. Reads client IDs
// from NEXT_PUBLIC_* env vars so the bundle picks them up at build time.
// The cleanup function from registerEnokiWallets is returned from the effect
// so wallets are torn down when the network changes (Enoki requires re-
// registration on network switch).
function RegisterEnokiWallets() {
  const { client, network } = useSuiClientContext();
  useEffect(() => {
    console.log('[auth:register] effect run, network=%s, client=%o', network, client?.network);
    if (!isEnokiNetwork(network)) {
      console.warn('[auth:register] skipping — network "%s" is not Enoki-compatible', network);
      return;
    }
    const apiKey = process.env.NEXT_PUBLIC_ENOKI_API_KEY;
    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!apiKey || !googleClientId) {
      // Surface as a console error so missing env vars are obvious in dev.
      // We don't throw — the navbar will gracefully render a disabled button
      // until the operator fills in the env.
      // eslint-disable-next-line no-console
      console.error(
        '[Enoki] Missing NEXT_PUBLIC_ENOKI_API_KEY or NEXT_PUBLIC_GOOGLE_CLIENT_ID. ' +
          'Get keys at https://portal.enoki.mystenlabs.com/.',
      );
      return;
    }
    console.log('[auth:register] calling registerEnokiWallets, apiKey=%s... clientId=%s...', apiKey.slice(0, 12), googleClientId.slice(0, 12));
    const { unregister } = registerEnokiWallets({
      apiKey,
      providers: {
        google: { clientId: googleClientId },
      },
      client,
      network,
    });
    console.log('[auth:register] done — wallets registered for network %s', network);
    return unregister;
  }, [client, network]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient for the lifetime of the app — dapp-kit hooks depend on
  // a QueryClientProvider being mounted above them.
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={DEFAULT_NETWORK}>
        <RegisterEnokiWallets />
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
