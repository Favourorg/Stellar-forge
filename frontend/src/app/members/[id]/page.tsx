import React, { useState, useEffect } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { Spinner } from '../../../components/UI/Spinner'
import { MemberCard, type MemberData } from '../../../components/member/MemberCard'

export default function MemberProfilePage() {
  const { id } = useParams<{ id: string }>()
  const [member, setMember] = useState<MemberData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    fetch(`/api/members/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error('Member not found')
        return res.json() as Promise<MemberData>
      })
      .then((d) => { if (!cancelled) setMember(d) })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error')
      })
      .finally(() => { if (!cancelled) setIsLoading(false) })

    return () => { cancelled = true }
  }, [id])

  if (!id) return <Navigate to="/" replace />
  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>
  if (error) return <p className="text-red-600 dark:text-red-400 text-center py-12">{error}</p>
  if (!member) return null

  return (
    <div className="container mx-auto px-4 py-8">
      <MemberCard member={member} />
    </div>
  )
}
