/**
 * Lecture de code-barres par la camera du telephone.
 *
 * C'est le geste central de l'application en magasin : viser un produit vaut
 * mieux que taper treize chiffres, et mieux encore que chercher « creme legere
 * uht 18% mg semi epaisse » dans un catalogue de plusieurs milliers de lignes.
 *
 * ---------------------------------------------------------------------------
 * DEUX CHEMINS DE DECODAGE
 * ---------------------------------------------------------------------------
 * `BarcodeDetector` est natif sur Android/Chrome : rapide, gratuit, aucun
 * telechargement. Safari ne l'implemente pas — et c'est precisement la cible.
 * On retombe donc sur ZXing, en JavaScript pur.
 *
 * ZXing pese plusieurs centaines de kilooctets. Il est charge par un `import()`
 * DYNAMIQUE, donc uniquement quand la camera s'ouvre vraiment : la page
 * d'accueil n'en paie pas le prix, et un utilisateur qui ne scanne jamais ne le
 * telecharge jamais.
 *
 * ---------------------------------------------------------------------------
 * PIEGES iOS, tous rencontres
 * ---------------------------------------------------------------------------
 *   - `playsInline` est OBLIGATOIRE : sans lui, Safari ouvre la video en plein
 *     ecran par-dessus l'application et le cadre de visee disparait.
 *   - `getUserMedia` exige HTTPS. En developpement sur `localhost` c'est
 *     tolere, mais pas sur une adresse IP de reseau local — d'ou le message
 *     explicite plutot qu'un echec muet.
 *   - Le flux n'est JAMAIS ouvert ni coupe ici : il est emprunte a
 *     `lib/camera.ts` et lui est rendu. Installee sur l'ecran d'accueil, la PWA
 *     redemandait l'acces a chaque ouverture du viseur, parce que chacune
 *     rappelait `getUserMedia`. `camera.ts` garde un seul flux, l'eteint a la
 *     fermeture et ne l'arrete qu'apres quelques minutes sans viseur : la
 *     diode et la batterie restent protegees.
 *   - L'autorisation refusee n'est pas rattrapable par le code : seule
 *     l'utilisateur peut la redonner dans les reglages du systeme. On le dit.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "../icons/index.js";
import { camera } from "../lib/camera.js";
import { Sheet } from "./Sheet.js";
import { TextField } from "./Field.js";
import "../styles/components.css";

/** Formats utiles en supermarche. Le QR n'a rien a faire sur un aliment. */
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] as const;

type Status =
  "starting" | "scanning" | "denied" | "unsupported" | "insecure" | "error";

interface NativeDetector {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
}

interface DetectorCtor {
  new (options: { formats: readonly string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

/**
 * Valide un code-barres produit.
 *
 * On verifie la CLE DE CONTROLE, pas seulement la longueur : un decodage
 * partiel sur une etiquette froissee rend volontiers douze chiffres justes et
 * un faux. Sans ce controle, on interroge OpenFoodFacts pour rien et on
 * annonce « produit introuvable » alors que le produit existe.
 */
export function isValidEan(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return false;

  // Somme ponderee 3/1 en partant de la droite, cle exclue.
  let sum = 0;
  for (let i = digits.length - 2; i >= 0; i--) {
    const digit = Number(digits[i]);
    sum += (digits.length - i) % 2 === 0 ? digit * 3 : digit;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(digits[digits.length - 1]);
}

export interface BarcodeScannerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Appele avec le code lu. La feuille ne se ferme pas d'elle-meme. */
  readonly onDetect: (code: string) => void;
  readonly title?: string;
  /** Affiche sous le cadre — « Ajouté : Nutella » pendant une session de courses. */
  readonly hint?: string | undefined;
  /** Laisse la camera ouverte apres une lecture, pour enchainer les produits. */
  readonly continuous?: boolean;
  /**
   * Rend le viseur SANS feuille, pour occuper l'ecran entier.
   *
   * L'appelant devient responsable de la sortie : plus de croix de fermeture,
   * plus de fond assombri. Reserve a l'ecran `/scan`, dont c'est tout le
   * propos.
   */
  readonly inline?: boolean;
}

export function BarcodeScanner({
  open,
  onClose,
  onDetect,
  title = "Scanner un code-barres",
  hint = "Visez le code-barres du produit",
  continuous = false,
  inline = false,
}: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  const [status, setStatus] = useState<Status>("starting");
  const [detail, setDetail] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  /** La saisie manuelle est repliee : c'est un recours, pas une etape. */
  const [manualOpen, setManualOpen] = useState(false);

  /**
   * Arrete le decodage et rend la camera a `camera.ts`, qui l'eteint.
   * Idempotent : appele a la fermeture ET au demontage, un seul rendu par
   * emprunt puisque `streamRef` est vide au second appel.
   */
  const stopCamera = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (stream) camera().release(stream);
  }, []);

  const handleCode = useCallback(
    (raw: string) => {
      const code = raw.replace(/\D/g, "");
      if (!isValidEan(code)) return;

      // Anti-rebond : la camera rend 15 images par seconde et le meme code
      // serait signale quinze fois. On ignore une relecture identique pendant
      // deux secondes — assez pour changer de produit, pas pour doubler.
      const now = Date.now();
      if (
        lastCodeRef.current.code === code &&
        now - lastCodeRef.current.at < 2000
      )
        return;
      lastCodeRef.current = { code, at: now };

      // Retour physique : en magasin, on ne regarde pas l'ecran en scannant.
      navigator.vibrate?.(60);
      onDetect(code);
      if (!continuous) stopCamera();
    },
    [continuous, onDetect, stopCamera],
  );

  useEffect(() => {
    if (!open) {
      stopCamera();
      return;
    }

    let cancelled = false;
    setStatus("starting");
    setDetail(null);

    const start = async () => {
      // `isSecureContext` couvre HTTPS ET localhost. C'est le bon test : une
      // adresse IP de reseau local en http echoue, et le message doit le dire.
      if (!window.isSecureContext) {
        setStatus("insecure");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        return;
      }

      let stream: MediaStream;
      try {
        stream = await camera().acquire();
      } catch (error) {
        if (cancelled) return;
        const name = (error as Error).name;
        setStatus(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : "error",
        );
        setDetail(
          name === "NotFoundError"
            ? "Aucune caméra détectée sur cet appareil."
            : null,
        );
        return;
      }

      if (cancelled) {
        camera().release(stream);
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* Safari rejette parfois play() sur un rendu concurrent : le flux
           demarre quand meme, inutile d'alarmer l'utilisateur. */
      }
      if (cancelled) return;
      setStatus("scanning");

      const Detector = (window as unknown as { BarcodeDetector?: DetectorCtor })
        .BarcodeDetector;
      if (Detector) {
        runNative(Detector, video);
      } else {
        await runZxing(video);
      }
    };

    /** Chemin natif : Android/Chrome. Une boucle sur les images de la video. */
    const runNative = (Ctor: DetectorCtor, video: HTMLVideoElement) => {
      const detector = new Ctor({ formats: [...FORMATS] });
      let frame = 0;
      let running = true;

      const tick = async () => {
        if (!running) return;
        try {
          const found = await detector.detect(video);
          const first = found[0];
          if (first) handleCode(first.rawValue);
        } catch {
          /* Une image illisible n'est pas une erreur : on tente la suivante. */
        }
        if (running) frame = requestAnimationFrame(() => void tick());
      };

      void tick();
      stopRef.current = () => {
        running = false;
        cancelAnimationFrame(frame);
      };
    };

    /** Chemin de repli : iOS. ZXing, telecharge seulement maintenant. */
    const runZxing = async (video: HTMLVideoElement) => {
      let reader: { decodeFromVideoElement: unknown } | null = null;
      try {
        const [
          { BrowserMultiFormatReader },
          { BarcodeFormat, DecodeHintType },
        ] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        if (cancelled) return;

        // On restreint aux formats de la grande distribution : moins de
        // formats a essayer, c'est un decodage nettement plus rapide sur un
        // telephone qui chauffe.
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
        ]);
        hints.set(DecodeHintType.TRY_HARDER, true);

        const instance = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 150,
        });
        reader = instance as unknown as { decodeFromVideoElement: unknown };

        const controls = await instance.decodeFromVideoElement(
          video,
          (result) => {
            if (result) handleCode(result.getText());
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        stopRef.current = () => controls.stop();
      } catch (error) {
        if (cancelled) return;
        void reader;
        setStatus("error");
        setDetail(
          error instanceof Error && /import|fetch|network/i.test(error.message)
            ? "Le module de lecture n’a pas pu être téléchargé. Vérifie ta connexion."
            : null,
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open, handleCode, stopCamera]);

  // Coupure de securite au demontage : une navigation pendant que la feuille
  // est ouverte ne doit pas laisser la camera allumee.
  useEffect(() => stopCamera, [stopCamera]);

  const submitManual = () => {
    const code = manual.replace(/\D/g, "");
    if (!isValidEan(code)) return;
    onDetect(code);
    setManual("");
  };

  const manualValid = isValidEan(manual);

  const contenu = (
    <div className={`scanner${inline ? " scanner--plein" : ""}`}>
      {/* Sur le viseur, jamais dans le flux : la saisie manuelle est un
            recours, pas une etape. */}
      <button
        type="button"
        className={`scanner__crayon${manualOpen ? " scanner__crayon--actif" : ""}`}
        onClick={() => setManualOpen((ouvert) => !ouvert)}
        aria-expanded={manualOpen}
        aria-label={
          manualOpen ? "Fermer la saisie manuelle" : "Saisir le code à la main"
        }
      >
        <Icon name="ui-edit" size={18} strokeWidth={1.8} />
      </button>

      {status === "scanning" || status === "starting" ? (
        <div className="scanner__stage">
          <video ref={videoRef} className="scanner__video" muted playsInline />
          {/* Le cadre n'est pas decoratif : sans repere visuel, on cadre trop
                large et le code n'occupe pas assez de pixels pour etre lu.
                QUATRE EQUERRES et non un rectangle ferme : elles bornent la
                zone sans poser de trait en travers du code, qu'on cherche
                justement a laisser voir. La ligne qui balaie dit que l'appareil
                cherche — sans elle, une camera qui ne trouve rien parait figee. */}
          <div className="viseur" aria-hidden="true">
            <span className="viseur__coin viseur__coin--hg" />
            <span className="viseur__coin viseur__coin--hd" />
            <span className="viseur__coin viseur__coin--bg" />
            <span className="viseur__coin viseur__coin--bd" />
            <span className="viseur__ligne" />
          </div>
          {hint && <p className="viseur__astuce">{hint}</p>}
          {status === "starting" && (
            <p className="scanner__overlay">Ouverture de la caméra…</p>
          )}
        </div>
      ) : (
        <div className="scanner__stage scanner__stage--message">
          <p className="status status--error" role="alert">
            {status === "denied" && "Accès à la caméra refusé."}
            {status === "insecure" &&
              "La caméra exige une connexion sécurisée (https)."}
            {status === "unsupported" &&
              "Ce navigateur ne donne pas accès à la caméra."}
            {status === "error" && "La caméra n’a pas pu démarrer."}
          </p>
          {detail && <p className="card__lead">{detail}</p>}
          {status === "denied" && (
            <p className="card__lead">
              Autorise l’appareil photo pour ce site dans les réglages de ton
              téléphone, puis rouvre cet écran. Le site ne peut pas redemander
              lui-même.
            </p>
          )}
        </div>
      )}

      {/* SAISIE MANUELLE, derriere le crayon du viseur.
            Elle occupait quatre lignes sous la camera alors qu'on ne s'en sert
            presque jamais : un code abime, un emballage brillant, une camera
            capricieuse. Le bouton reste visible dans TOUS les etats, y compris
            quand la camera est refusee, ou elle est le seul chemin. */}
      {manualOpen && (
        <div className="scanner__manual">
          <TextField
            label="Code-barres"
            value={manual}
            onChange={setManual}
            inputMode="numeric"
            placeholder="3017620422003"
            autoFocus
            {...(manual.length > 0 && !manualValid
              ? { error: "Ce code est incomplet ou mal recopié." }
              : {})}
          />
          <button
            type="button"
            className="button button--primary button--block"
            onClick={submitManual}
            disabled={!manualValid}
          >
            Chercher ce code
          </button>
        </div>
      )}
    </div>
  );

  /*
   * EN PLEIN ECRAN, le viseur n'est pas enferme dans une feuille.
   *
   * C'est la difference la plus visible avec la maquette : une camera de 4/3
   * posee au milieu d'une feuille blanche se regarde, un viseur qui occupe
   * l'ecran se VISE. Le mode reste optionnel — les trois points de scan
   * historiques (bibliotheque, chariot, frigo) s'ouvrent par-dessus l'ecran
   * qu'on consultait, et une feuille y est le bon contenant.
   *
   * Toute la mecanique — demarrage de la camera, chargement de ZXing, etats
   * d'erreur, saisie manuelle, anti-rebond — reste ICI, en un seul endroit :
   * seul le contenant change.
   */
  if (inline) return open ? contenu : null;

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {contenu}
    </Sheet>
  );
}
