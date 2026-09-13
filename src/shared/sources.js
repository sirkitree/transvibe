export function sourceName (url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return ({ 'nhm.ac.uk': 'the Natural History Museum', 'nasa.gov': 'NASA' })[host] || host
  } catch { return '' }
}

export function answerSources (text) {
  return [...new Set(String(text || '').match(/https?:\/\/[^\s)<>]+/g) || [])]
    .map(url => url.replace(/[.,;!?]+$/, ''))
    .map(url => ({ url, label: sourceName(url) }))
}

