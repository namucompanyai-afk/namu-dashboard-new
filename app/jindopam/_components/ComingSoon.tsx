import React from 'react'

export default function ComingSoon({
  title,
  description,
  emoji,
}: {
  title: string
  description: string
  emoji: string
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="text-6xl mb-4">{emoji}</div>
      <h1 className="text-2xl font-semibold mb-2">{title}</h1>
      <p className="text-sm text-gray-500 max-w-md">{description}</p>
      <span className="mt-6 text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
        준비 중
      </span>
    </div>
  )
}
