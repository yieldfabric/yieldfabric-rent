/**
 * Asset catalog loader.
 *
 * Rent is denominated in an on-chain asset (e.g. `aud-token-asset`).
 * The catalog lives on the payments subgraph; reads go through the
 * federated gateway — the same `assets.all` query the first-party app
 * uses to populate denomination pickers.
 */
import { useEffect, useState } from 'react';
import { gatewayQuery } from './graphql';

export interface AssetRow {
  id: string;
  name?: string | null;
  currency?: string | null;
  assetType?: string | null;
}

const ASSETS_QUERY = `
  query RentAssets {
    assets {
      all {
        id
        name
        currency
        assetType
      }
    }
  }
`;

export function useAssets(): {
  assets: AssetRow[];
  loading: boolean;
  error: string | null;
} {
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gatewayQuery<{ assets: { all: AssetRow[] } }>(ASSETS_QUERY)
      .then((data) => {
        if (cancelled) return;
        setAssets(data.assets?.all ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { assets, loading, error };
}
