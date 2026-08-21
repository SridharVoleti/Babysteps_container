'use client'

import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react'

interface RevealProps {
  children: ReactNode
  /** extra transition delay for stagger effects */
  delayMs?: number
  className?: string
  /** rendered element/tag (div, article, li, section…) */
  as?: ElementType
  /** reveal once and stay visible (default) or re-hide when scrolled away */
  once?: boolean
  /** IntersectionObserver visibility threshold */
  threshold?: number
}

/**
 * Reveal — scroll-triggered entrance animation (fade + rise).
 *
 * Styling lives in globals.css (.reveal / .reveal-visible) and is fully
 * disabled by prefers-reduced-motion. Falls back to always-visible when
 * IntersectionObserver is unavailable.
 */
export function Reveal({
  children,
  delayMs = 0,
  className = '',
  as: Tag = 'div',
  once = true,
  threshold = 0.15,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            if (once) observer.unobserve(entry.target)
          } else if (!once) {
            setVisible(false)
          }
        }
      },
      { threshold },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [once, threshold])

  return (
    <Tag
      ref={ref}
      className={`reveal${visible ? ' reveal-visible' : ''}${className ? ` ${className}` : ''}`}
      style={delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </Tag>
  )
}
