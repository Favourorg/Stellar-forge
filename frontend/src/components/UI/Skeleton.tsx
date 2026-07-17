import React from 'react'

interface SkeletonProps {
  className?: string
  count?: number
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = 'h-4 w-full', count = 1 }) => {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`bg-gray-200 dark:bg-gray-700 rounded animate-pulse ${className} ${i > 0 ? 'mt-2' : ''}`}
          aria-hidden="true"
        />
      ))}
    </>
  )
}

export const SkeletonCard: React.FC = () => (
  <div className="bg-white dark:bg-gray-800 p-4 sm:p-6 rounded-lg shadow-sm space-y-4">
    <Skeleton className="h-6 w-1/3" />
    <div className="space-y-3">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-4/6" />
    </div>
  </div>
)

/** Matches the shape of a TokenCard list item */
export const TokenCardSkeleton: React.FC = () => (
  <li
    className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg p-4"
    aria-hidden="true"
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-baseline gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-12" />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-40 col-span-2" />
          <Skeleton className="h-3 w-28 col-span-2" />
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 shrink-0">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  </li>
)

/** Matches the shape of the TokenDetail page while loading */
export const TokenDetailSkeleton: React.FC = () => (
  <div className="space-y-6 max-w-2xl mx-auto" aria-busy="true" aria-label="Loading token details">
    {/* Header */}
    <div className="flex items-center justify-between">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-9 w-20" />
    </div>
    {/* Info card */}
    <div className="bg-white dark:bg-gray-800 p-4 sm:p-6 rounded-lg shadow-sm">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
    {/* Action buttons */}
    <div className="flex gap-3">
      <Skeleton className="h-10 w-28 rounded-md" />
      <Skeleton className="h-10 w-28 rounded-md" />
    </div>
  </div>
)

/** @deprecated Use TokenCardSkeleton */
export const SkeletonTokenCard = TokenCardSkeleton
