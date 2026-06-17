'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  genAddressSeed,
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  jwtToAddress,
} from '@mysten/sui/zklogin';

const NETWORK = 'testnet';
const PROVER_URL = 'https://prover-dev.mystenlabs.com/v1';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
const SERVER_RPC_URL =
  process.env.SUI_RPC_UPSTREAM_URL ??
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  getJsonRpcFullnodeUrl(NETWORK);
const SUI_RPC_URL =
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  (typeof window === 'undefined' ? SERVER_RPC_URL : '/api/sui');
const DEFAULT_EXECUTE_OPTIONS = {
  showEffects: true,
  showEvents: true,
  showObjectChanges: true,
  showBalanceChanges: true,
};

export const SUI_CLIENT = new SuiJsonRpcClient({
  network: NETWORK,
  url: SUI_RPC_URL,
});

export interface ZkLoginState {
  address: string | null;
  jwt: string | null;
  isLoading: boolean;
  error: string | null;
}

interface StoredSession {
  privateKey: string;
  randomness: string;
  maxEpoch: number;
  nonce: string;
}

interface ProofResponse {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
}

interface StoredProofEnvelope {
  proof: ProofResponse;
  salt: string;
  maxEpoch: number;
  addressSeed: string;
}

interface JwtClaims {
  sub: string;
  aud: string | string[];
  iss: string;
}

type ExecuteOptions = {
  showEffects?: boolean;
  showEvents?: boolean;
  showObjectChanges?: boolean;
  showBalanceChanges?: boolean;
  showInput?: boolean;
  showRawInput?: boolean;
};

interface SignAndExecuteInput {
  transaction: Transaction;
  options?: ExecuteOptions;
}

interface ZkLoginCtx extends ZkLoginState {
  client: SuiJsonRpcClient;
  isReady: boolean;
  loginWithGoogle: () => Promise<void>;
  logout: () => void;
  signAndExecuteTransaction: (input: SignAndExecuteInput) => Promise<SuiTransactionBlockResponse>;
}

const S_SESSION = 'pv_zklogin_session';
const L_ADDRESS = 'pv_zklogin_address';
const L_JWT = 'pv_zklogin_jwt';
const L_PROOF = 'pv_zklogin_proof';
const L_SALT = 'pv_zklogin_salt';

function saveSession(
  keypair: Ed25519Keypair,
  randomness: string,
  maxEpoch: number,
  nonce: string,
) {
  const stored: StoredSession = {
    privateKey: keypair.getSecretKey(),
    randomness,
    maxEpoch,
    nonce,
  };
  sessionStorage.setItem(S_SESSION, JSON.stringify(stored));
}

function loadSession(): {
  keypair: Ed25519Keypair;
  randomness: string;
  maxEpoch: number;
} | null {
  try {
    const raw = sessionStorage.getItem(S_SESSION);
    if (!raw) return null;
    const session = JSON.parse(raw) as StoredSession;
    return {
      keypair: Ed25519Keypair.fromSecretKey(session.privateKey),
      randomness: session.randomness,
      maxEpoch: session.maxEpoch,
    };
  } catch {
    return null;
  }
}

function loadStoredProof(): StoredProofEnvelope | null {
  try {
    const raw = localStorage.getItem(L_PROOF);
    return raw ? (JSON.parse(raw) as StoredProofEnvelope) : null;
  } catch {
    return null;
  }
}

function decodeJwtClaims(jwt: string): JwtClaims {
  return JSON.parse(atob(jwt.split('.')[1])) as JwtClaims;
}

function getAudience(claims: JwtClaims): string {
  return Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
}

function getOrCreateSalt(sub: string): string {
  const key = `${L_SALT}_${sub}`;
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const salt = String(
    BigInt(
      `0x${Array.from(sub)
        .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')}`,
    ) % (1n << 128n),
  );
  localStorage.setItem(key, salt);
  return salt;
}

async function fetchProof(
  jwt: string,
  extendedEphemeralPublicKey: string,
  maxEpoch: number,
  randomness: string,
  salt: string,
): Promise<ProofResponse> {
  const response = await fetch(PROVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jwt,
      extendedEphemeralPublicKey,
      maxEpoch,
      jwtRandomness: randomness,
      salt,
      keyClaimName: 'sub',
    }),
  });

  if (!response.ok) {
    throw new Error(`Prover returned ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<ProofResponse>;
}

const ZkLoginContext = createContext<ZkLoginCtx | null>(null);

export function useZkLogin(): ZkLoginCtx {
  const context = useContext(ZkLoginContext);
  if (!context) {
    throw new Error('useZkLogin must be used inside ZkLoginProvider');
  }
  return context;
}

export function ZkLoginProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ZkLoginState>({
    address: null,
    jwt: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    const address = localStorage.getItem(L_ADDRESS);
    const jwt = localStorage.getItem(L_JWT);
    if (address && jwt) {
      setState((current) => ({ ...current, address, jwt }));
    }
  }, []);

  const handleOAuthCallback = useCallback(async (idToken: string) => {
    setState((current) => ({ ...current, isLoading: true, error: null }));

    try {
      const session = loadSession();
      if (!session) {
        throw new Error('Session expired. Sign in again.');
      }

      const claims = decodeJwtClaims(idToken);
      const salt = getOrCreateSalt(claims.sub);
      const address = jwtToAddress(idToken, salt, true);
      const addressSeed = genAddressSeed(salt, 'sub', claims.sub, getAudience(claims)).toString();

      const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(
        session.keypair.getPublicKey(),
      );

      const proof = await fetchProof(
        idToken,
        extendedEphemeralPublicKey,
        session.maxEpoch,
        session.randomness,
        salt,
      );

      localStorage.setItem(L_JWT, idToken);
      localStorage.setItem(L_ADDRESS, address);
      localStorage.setItem(
        L_PROOF,
        JSON.stringify({
          proof,
          salt,
          maxEpoch: session.maxEpoch,
          addressSeed,
        } satisfies StoredProofEnvelope),
      );

      setState({
        address,
        jwt: idToken,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        isLoading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash.includes('id_token=')) return;

    const params = new URLSearchParams(hash.slice(1));
    const idToken = params.get('id_token');
    if (!idToken) return;

    window.history.replaceState(null, '', window.location.pathname);
    void handleOAuthCallback(idToken);
  }, [handleOAuthCallback]);

  const loginWithGoogle = useCallback(async () => {
    setState((current) => ({ ...current, isLoading: true, error: null }));

    try {
      if (!GOOGLE_CLIENT_ID) {
        throw new Error('NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set');
      }

      const latestState = await SUI_CLIENT.getLatestSuiSystemState();
      const maxEpoch = Number(latestState.epoch) + 10;
      const randomness = generateRandomness();
      const keypair = new Ed25519Keypair();
      const nonce = generateNonce(keypair.getPublicKey(), maxEpoch, randomness);

      saveSession(keypair, randomness, maxEpoch, nonce);

      const redirectUri = `${window.location.origin}/auth/callback`;
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'id_token',
        scope: 'openid email profile',
        nonce,
      });

      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    } catch (error) {
      setState((current) => ({
        ...current,
        isLoading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(L_JWT);
    localStorage.removeItem(L_ADDRESS);
    localStorage.removeItem(L_PROOF);
    sessionStorage.removeItem(S_SESSION);
    setState({
      address: null,
      jwt: null,
      isLoading: false,
      error: null,
    });
  }, []);

  const signAndExecuteTransaction = useCallback(
    async ({ transaction, options }: SignAndExecuteInput) => {
      const session = loadSession();
      if (!session) {
        throw new Error('Missing zkLogin session. Sign in again.');
      }

      const storedProof = loadStoredProof();
      if (!storedProof) {
        throw new Error('Missing zkLogin proof. Sign in again.');
      }

      if (!state.address) {
        throw new Error('Missing zkLogin address. Sign in again.');
      }

      const sender = normalizeSuiAddress(state.address);
      transaction.setSenderIfNotSet(sender);

      const bytes = await transaction.build({ client: SUI_CLIENT });
      const { signature: userSignature } = await session.keypair.signTransaction(bytes);
      const zkLoginSignature = getZkLoginSignature({
        inputs: {
          ...storedProof.proof,
          addressSeed: storedProof.addressSeed,
        },
        maxEpoch: storedProof.maxEpoch,
        userSignature,
      });

      return SUI_CLIENT.executeTransactionBlock({
        transactionBlock: bytes,
        signature: zkLoginSignature,
        options: {
          ...DEFAULT_EXECUTE_OPTIONS,
          ...options,
        },
      });
    },
    [state.address],
  );

  const value: ZkLoginCtx = {
    ...state,
    client: SUI_CLIENT,
    isReady: Boolean(state.address && state.jwt && loadStoredProof() && loadSession()),
    loginWithGoogle,
    logout,
    signAndExecuteTransaction,
  };

  return <ZkLoginContext.Provider value={value}>{children}</ZkLoginContext.Provider>;
}
