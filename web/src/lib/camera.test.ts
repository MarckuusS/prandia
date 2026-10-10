/**
 * Le flux camera partage : ce qui doit tenir pour que l'iPhone repose la
 * question le moins souvent possible, sans laisser la camera reservee.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCameraPool } from './camera.js'

class FakeTrack {
  enabled = true
  readyState: 'live' | 'ended' = 'live'
  stop() {
    this.readyState = 'ended'
  }
}

function fakeStream() {
  const track = new FakeTrack()
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

const IDLE = 1_000

function setup() {
  const streams: Array<ReturnType<typeof fakeStream>> = []
  const getUserMedia = vi.fn(async () => {
    const made = fakeStream()
    streams.push(made)
    return made.stream
  })
  const pool = createCameraPool({ getUserMedia, idleStopMs: IDLE })
  return { pool, getUserMedia, streams }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createCameraPool', () => {
  it('ne redemande pas la camera au scan suivant', async () => {
    const { pool, getUserMedia } = setup()
    const first = await pool.acquire()
    pool.release(first)
    const second = await pool.acquire()

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('desactive les pistes a la fermeture du viseur, sans les arreter', async () => {
    const { pool, streams } = setup()
    pool.release(await pool.acquire())

    expect(streams[0]?.track.enabled).toBe(false)
    expect(streams[0]?.track.readyState).toBe('live')
  })

  it('reactive les pistes a la reouverture', async () => {
    const { pool, streams } = setup()
    pool.release(await pool.acquire())
    await pool.acquire()

    expect(streams[0]?.track.enabled).toBe(true)
  })

  it('arrete le flux apres le delai sans viseur ouvert', async () => {
    const { pool, getUserMedia, streams } = setup()
    pool.release(await pool.acquire())

    vi.advanceTimersByTime(IDLE - 1)
    expect(streams[0]?.track.readyState).toBe('live')
    vi.advanceTimersByTime(1)
    expect(streams[0]?.track.readyState).toBe('ended')

    await pool.acquire()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('un viseur rouvert avant le delai annule l arret programme', async () => {
    const { pool, streams } = setup()
    pool.release(await pool.acquire())
    vi.advanceTimersByTime(IDLE / 2)
    await pool.acquire()
    vi.advanceTimersByTime(IDLE * 2)

    expect(streams[0]?.track.readyState).toBe('live')
    expect(streams[0]?.track.enabled).toBe(true)
  })

  it('fermer un viseur ne coupe pas celui qui reste ouvert', async () => {
    const { pool, streams } = setup()
    const a = await pool.acquire()
    await pool.acquire()
    pool.release(a)
    vi.advanceTimersByTime(IDLE * 2)

    expect(streams[0]?.track.enabled).toBe(true)
    expect(streams[0]?.track.readyState).toBe('live')
  })

  it('deux viseurs qui demarrent ensemble ne posent qu une question', async () => {
    const { pool, getUserMedia } = setup()
    const [a, b] = await Promise.all([pool.acquire(), pool.acquire()])

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('un refus n est pas memorise : la tentative suivante redemande', async () => {
    const { pool, getUserMedia } = setup()
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('refus'), { name: 'NotAllowedError' }))

    await expect(pool.acquire()).rejects.toMatchObject({ name: 'NotAllowedError' })
    await pool.acquire()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('une piste terminee par le systeme est remplacee', async () => {
    const { pool, getUserMedia, streams } = setup()
    const first = await pool.acquire()
    pool.release(first)
    if (streams[0]) streams[0].track.readyState = 'ended'

    const second = await pool.acquire()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(second).not.toBe(first)
  })

  it('un flux arrive apres un arret general est coupe, pas garde', async () => {
    let resolve: (stream: MediaStream) => void = () => {}
    const late = fakeStream()
    const pool = createCameraPool({
      getUserMedia: () => new Promise<MediaStream>((r) => (resolve = r)),
      idleStopMs: IDLE,
    })

    const pendingAcquire = pool.acquire()
    pool.stopAll()
    resolve(late.stream)

    await expect(pendingAcquire).rejects.toMatchObject({ name: 'AbortError' })
    expect(late.track.readyState).toBe('ended')
  })

  it('arret general : plus rien ne tourne, plus rien n est programme', async () => {
    const { pool, streams } = setup()
    await pool.acquire()
    pool.stopAll()

    expect(streams[0]?.track.readyState).toBe('ended')
    expect(vi.getTimerCount()).toBe(0)
  })
})
