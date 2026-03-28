
import React from 'react';
import { useTransactionHistory } from '../hooks/useTransactionHistory';
import { CopyButton } from './CopyButton'

interface TransactionHistoryProps {
  publicKey?: string;
  contractId?: string;
  assetCodes?: string[];
  issuer?: string;
  contractIds?: string[];
}

const badgeColors: Record<string, string> = {
  create: 'bg-blue-100 text-blue-800',
  mint: 'bg-green-100 text-green-800',
  burn: 'bg-red-100 text-red-800',
  success: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  publicKey = '',
  contractId,
  assetCodes,
  issuer,
  contractIds,
}) => {
  const resolvedContractIds = contractId ? [contractId, ...(contractIds ?? [])] : contractIds
  const { transactions, loading, error, hasMore, loadMore } = useTransactionHistory(publicKey, {
    assetCodes,
    issuer,
    contractIds: resolvedContractIds,
    pageSize: 10,
  });

  // Infinite scroll
  React.useEffect(() => {
    const handleScroll = () => {
      if (
        window.innerHeight + document.documentElement.scrollTop >=
          document.documentElement.offsetHeight - 200 &&
        hasMore &&
        !loading
      ) {
        loadMore();
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [hasMore, loading, loadMore]);

  return (
    <div className="w-full max-w-3xl mx-auto p-4">
      <h2 className="text-2xl font-bold mb-4">Transaction History</h2>
      {loading && transactions.length === 0 && (
        <div className="animate-pulse space-y-2" aria-label="Loading transactions" aria-busy="true">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-10 bg-gray-200 rounded" />
          ))}
        </div>
      )}
      {error && <div className="text-red-600 mb-2">{error}</div>}
      {!loading && transactions.length === 0 && !error && (
        <div className="text-gray-500 text-center py-8">No transactions found.</div>
      )}
      {transactions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white border rounded shadow">
            <caption className="sr-only">Transaction history</caption>
            <thead>
              <tr>
                <th scope="col" className="px-4 py-2">Type</th>
                <th scope="col" className="px-4 py-2">Token</th>
                <th scope="col" className="px-4 py-2">Amount</th>
                <th scope="col" className="px-4 py-2">Date</th>
                <th scope="col" className="px-4 py-2">Status</th>
                <th scope="col" className="px-4 py-2">Link</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id} className="border-t">
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-1 rounded text-xs font-semibold ${badgeColors[tx.type] || 'bg-gray-100 text-gray-800'}`}
                    >
                      {tx.type}
                    </span>
                  </td>
                  <td className="px-4 py-2">{tx.token}</td>
                  <td className="px-4 py-2">{tx.amount}</td>
                  <td className="px-4 py-2">{formatDate(tx.date)}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-1 rounded text-xs font-semibold ${badgeColors[tx.status] || 'bg-gray-100 text-gray-800'}`}
                    >
                      {tx.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <a
                        href={`https://stellar.expert/explorer/public/tx/${tx.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 underline"
                        aria-label={`View transaction ${tx.hash} on Stellar Explorer`}
                      >
                        View
                      </a>
                      <CopyButton value={tx.hash} ariaLabel="Copy transaction hash" className="text-gray-400" />
                    </div>
                  </td>
                </tr>
              ))}
              {loading && (
                <tr>
                  <td colSpan={6} className="text-center py-4">
                    <span className="animate-pulse text-gray-400">Loading...</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString();
}

export default TransactionHistory;
