import { describe, expect, it } from 'vitest'

import { HttpError } from './http.js'
import { imagesDuCorps } from './imageRecue.js'

/** Un faux JPEG : sa signature, puis du remplissage. */
const jpeg = (taille: number, remplissage: number) => {
  const octets = new Uint8Array(taille).fill(remplissage)
  octets.set([0xff, 0xd8, 0xff])
  return octets
}

const requete = (morceaux: Uint8Array[], entete: string) =>
  new Request('https://prandia.test/api/scan/article', {
    method: 'POST',
    headers: { 'x-photos': entete },
    body: new Blob(morceaux),
  })

const code = async (promesse: Promise<unknown>) => {
  try {
    await promesse
    return 'aucune erreur'
  } catch (erreur) {
    return erreur instanceof HttpError ? erreur.code : String(erreur)
  }
}

describe('imagesDuCorps, plusieurs photos dans un corps', () => {
  it('decoupe le corps selon les tailles annoncees, chaque photo dans son bloc', async () => {
    const a = jpeg(40, 1)
    const b = jpeg(25, 2)
    const blocs = await imagesDuCorps(requete([a, b], '40,25'), 1000, 3)
    expect(blocs).toHaveLength(2)
    const donnees = blocs.map((bloc) => (bloc['source'] as { data: string; media_type: string }))
    expect(donnees.every((d) => d.media_type === 'image/jpeg')).toBe(true)
    expect(atob(donnees[1]?.data ?? '').length).toBe(25)
    expect(atob(donnees[1]?.data ?? '').charCodeAt(5)).toBe(2)
  })

  it('refuse des tailles qui ne font pas le corps, ou trop de photos', async () => {
    expect(await code(imagesDuCorps(requete([jpeg(40, 1)], '30'), 1000, 3))).toBe('scan_unreadable')
    expect(await code(imagesDuCorps(requete([jpeg(40, 1)], ''), 1000, 3))).toBe('scan_empty')
    expect(await code(imagesDuCorps(requete([jpeg(4, 1)], '1,1,1,1'), 1000, 3))).toBe('scan_empty')
    expect(await code(imagesDuCorps(requete([jpeg(40, 1)], '20,-20,40'), 1000, 3))).toBe('scan_empty')
  })

  it('type chaque morceau par ses octets, et borne le corps entier', async () => {
    const pasUneImage = new Uint8Array(20).fill(7)
    expect(await code(imagesDuCorps(requete([jpeg(20, 1), pasUneImage], '20,20'), 1000, 3))).toBe('scan_not_image')
    expect(await code(imagesDuCorps(requete([jpeg(600, 1), jpeg(600, 1)], '600,600'), 1000, 3))).toBe('scan_too_large')
  })
})
