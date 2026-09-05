import { encodeSpeechWav } from './speech-wav.mjs'

export async function startSpeechRecording() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Микрофон доступен только по HTTPS или на localhost.')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const context = new AudioContext({ sampleRate: 16000 })
  let node: AudioWorkletNode | undefined
  const chunks: Float32Array[] = []
  let samples = 0
  let closed = false
  const cancel = () => {
    if (closed) return
    closed = true
    stream.getTracks().forEach((track) => track.stop())
    node?.disconnect()
    void context.close().catch(() => {})
  }
  try {
    await context.audioWorklet.addModule('/voice-capture-worklet.js')
    node = new AudioWorkletNode(context, 'skazanie-voice-capture')
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!closed && samples < context.sampleRate * 60) { chunks.push(event.data); samples += event.data.length }
    }
    const muted = context.createGain()
    muted.gain.value = 0
    context.createMediaStreamSource(stream).connect(node)
    node.connect(muted).connect(context.destination)
    await context.resume()
    return {
      cancel,
      finish: () => { cancel(); return new Blob([encodeSpeechWav(chunks, context.sampleRate)], { type: 'audio/wav' }) },
    }
  } catch (error) { cancel(); throw error }
}
