const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function parseEvents (text) {
  const lines = text.split('\n')
  return lines.flatMap((line, i) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch (err) {
      // The currently appended final line may be incomplete while recording.
      if (i === lines.length - 1) return []
      throw new Error(`Invalid event JSON on line ${i + 1}: ${err.message}`)
    }
  })
}

export function reviewHtml (events) {
  const starts = new Map(events.filter(e => e.type === 'transcription-start').map(e => [e.debugId, e]))
  const audio = file => /^[a-zA-Z0-9-]+\.wav$/.test(file || '')
    ? `<audio controls preload="none" src="${escape(file)}"></audio>` : ''
  const important = events.filter(e => e.type !== 'audio-span' && !(e.type.startsWith('transcription-') && e.interim))
  const cards = important.map(e => {
    const start = starts.get(e.debugId)
    let body = ''
    if (e.type === 'transcription-result') {
      body = `${audio(start?.audio)}<dl><dt>Whisper raw text</dt><dd>${escape(e.rawText)}</dd><dt>After filtering and corrections</dt><dd>${escape(e.text)}</dd><dt>Rejection / error</dt><dd>${escape(e.dropped || e.error || 'none')}</dd></dl>`
    } else if (e.type === 'conversation-question') {
      body = `<p><b>You → ${escape(e.agent)}</b></p><p>${escape(e.question)}</p>`
    } else if (e.type === 'conversation-answer') {
      body = `<p><b>${escape(e.answer?.via || e.asked)}</b></p><p>${escape(e.answer?.text)}</p>`
    }
    return `<article><header>${escape(e.at)} · ${escape(e.type)}</header>${body}<details${body ? '' : ' open'}><summary>Event details</summary><pre>${escape(JSON.stringify(e, null, 2))}</pre></details></article>`
  }).join('\n')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self'; style-src 'unsafe-inline'"><title>Mira session review</title>
<style>body{font:16px system-ui;max-width:960px;margin:32px auto;padding:0 24px;background:#f4f5f7;color:#1e2530}article{background:white;border:1px solid #d8dde5;border-radius:8px;padding:16px;margin:16px 0}header{color:#566174;font-size:13px}p,dd{white-space:pre-wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}audio{width:100%;margin-top:12px}dt{font-weight:bold}dd{margin:6px 0 14px}summary{cursor:pointer}</style>
<h1>Mira session review</h1><p>Local recording. Regenerate this report to see newer events. The full microphone track concatenates recorded spans; pauses are omitted. Use audio-span events in events.jsonl for wall-clock alignment.</p>
${audio('microphone.wav')}<p>Compare each utterance’s audio with the raw text, corrected text, and routing decision. Then review the reply against your intended question and conversation history. Write the intended wording and desired reply in notes.md; recognition output is not ground truth.</p>
<p>${events.length} events. Interim recognition and audio-span details remain in events.jsonl. No data is uploaded by this report.</p>${cards}`
}
