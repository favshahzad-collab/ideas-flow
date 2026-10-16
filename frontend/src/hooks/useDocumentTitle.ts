import { useEffect } from 'react'

const APP_NAME = 'Ideas Flow'

/**
 * Sets the browser tab and history-entry title.
 *
 * Every screen shipped the same static "Ideas Flow" from `index.html`, which
 * fails WCAG 2.4.2 (Page Titled, Level A) and makes a row of open tabs, the
 * back-history list and bookmarks indistinguishable from one another.
 *
 * Pass nothing to fall back to the bare application name.
 */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    /*
     * Put back what was there, on the way out.
     *
     * Without the cleanup the title outlives the component that set it, so
     * anything mounting *alongside* a screen rather than replacing it - a
     * full-page dialog, the designer opened over the top, a lazy route torn
     * down - leaves the tab naming a screen that is no longer on it.
     */
    const previous = document.title
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME

    return () => {
      document.title = previous
    }
  }, [title])
}
