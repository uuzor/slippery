import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { NextResponse } from 'next/server';

const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? 'testnet') as
  | 'testnet'
  | 'mainnet'
  | 'devnet'
  | 'localnet';

const UPSTREAM_URL =
  process.env.SUI_RPC_UPSTREAM_URL ??
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  getJsonRpcFullnodeUrl(NETWORK);

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.text();
  const upstream = await fetch(UPSTREAM_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body,
    cache: 'no-store',
  });

  const responseText = await upstream.text();

  return new NextResponse(responseText, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
