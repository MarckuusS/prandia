// Design system central pour Prandia.
//
// Singleton QML enregistré côté Python via `qmlRegisterSingletonType(url, "App", 1, 0, "Theme")`.
// Accessible depuis n'importe quel scope QML (MenuBar, Popup, Dialog inclus) via
//
//     import App
//     Text { color: Theme.colorPrimary }
//
// Bascule clair/sombre : `Theme.darkMode = !Theme.darkMode` (Phase 4).

pragma Singleton
import QtQuick

QtObject {
    // ============================================================ Mode

    property bool darkMode: false

    // ============================================================ Palette
    // Chaque couleur a 3 variantes (base / hover / pressed) quand pertinent.
    // Inspiré de Tailwind CSS pour la lisibilité.

    readonly property color colorPrimary:          darkMode ? "#3b82f6" : "#2563eb"
    readonly property color colorPrimaryHover:     darkMode ? "#60a5fa" : "#1d4ed8"
    readonly property color colorPrimaryPressed:   darkMode ? "#2563eb" : "#1e40af"
    readonly property color colorPrimaryDisabled:  darkMode ? "#475569" : "#cbd5e1"
    readonly property color colorOnPrimary:        "#ffffff"

    readonly property color colorSecondary:        darkMode ? "#a78bfa" : "#7c3aed"
    readonly property color colorSecondaryHover:   darkMode ? "#c4b5fd" : "#6d28d9"
    readonly property color colorSecondaryPressed: darkMode ? "#8b5cf6" : "#5b21b6"

    readonly property color colorBackground:       darkMode ? "#0f172a" : "#f8fafc"
    readonly property color colorSurface:          darkMode ? "#1e293b" : "#ffffff"
    readonly property color colorSurfaceHover:     darkMode ? "#334155" : "#f1f5f9"
    readonly property color colorSurfacePressed:   darkMode ? "#475569" : "#e2e8f0"

    readonly property color colorText:             darkMode ? "#f1f5f9" : "#0f172a"
    readonly property color colorTextSecondary:    darkMode ? "#94a3b8" : "#475569"
    // Texte désactivé : assez clair pour rester lisible sur fond sombre.
    readonly property color colorTextDisabled:     darkMode ? "#94a3b8" : "#cbd5e1"
    readonly property color colorTextPlaceholder:  darkMode ? "#64748b" : "#94a3b8"

    readonly property color colorBorder:           darkMode ? "#334155" : "#e2e8f0"
    readonly property color colorBorderHover:      darkMode ? "#475569" : "#cbd5e1"
    readonly property color colorBorderFocus:      darkMode ? "#60a5fa" : "#3b82f6"

    readonly property color colorAccent:           darkMode ? "#22d3ee" : "#0891b2"
    readonly property color colorError:            darkMode ? "#f87171" : "#dc2626"
    readonly property color colorErrorHover:       darkMode ? "#fca5a5" : "#b91c1c"
    readonly property color colorSuccess:          darkMode ? "#4ade80" : "#16a34a"
    readonly property color colorWarning:          darkMode ? "#fbbf24" : "#ea580c"

    readonly property color colorOverlay:          Qt.rgba(0, 0, 0, 0.45)
    readonly property color colorTransparent:      "transparent"

    // ============================================================ Typographie

    readonly property string fontFamily: Qt.platform.os === "windows"
                                       ? "Segoe UI"
                                       : Qt.platform.os === "osx"
                                         ? "SF Pro Text"
                                         : "Inter, Helvetica, Arial, sans-serif"

    readonly property int fontSizeXs:     10
    readonly property int fontSizeSm:     11
    readonly property int fontSizeMd:     13   // base / body
    readonly property int fontSizeLg:     15
    readonly property int fontSizeXl:     18
    readonly property int fontSizeTitle:  22

    readonly property int fontWeightRegular:  Font.Normal      // 400
    readonly property int fontWeightMedium:   Font.Medium      // 500
    readonly property int fontWeightSemiBold: Font.DemiBold    // 600
    readonly property int fontWeightBold:     Font.Bold        // 700

    // ============================================================ Espacements (en px)
    // Multiples de 4 — base typographique cohérente

    readonly property int spaceXs:  4
    readonly property int spaceSm:  8
    readonly property int spaceMd:  12
    readonly property int spaceLg:  16
    readonly property int spaceXl:  24
    readonly property int spaceXxl: 32

    // ============================================================ Rayons de bordure

    readonly property int radiusSm:    4
    readonly property int radiusMd:    6
    readonly property int radiusLg:    10
    readonly property int radiusXl:    14
    readonly property int radiusFull:  9999

    // ============================================================ Animations (durée en ms)

    readonly property int durationFast:    150
    readonly property int durationNormal:  250
    readonly property int durationSlow:    400

    readonly property int easingStandard: Easing.OutCubic
    readonly property int easingEnter:    Easing.OutQuad
    readonly property int easingExit:     Easing.InQuad

    // ============================================================ Ombres
    // QML 6 fournit MultiEffect pour les vraies drop-shadows. En attendant, on
    // empile des Rectangle avec opacité décroissante (cf. AppButton, AppDialog).

    readonly property color shadowColor: darkMode ? "#000000" : "#0f172a"
    readonly property real shadowOpacitySubtle:   darkMode ? 0.35 : 0.06
    readonly property real shadowOpacityNormal:   darkMode ? 0.50 : 0.12
    readonly property real shadowOpacityElevated: darkMode ? 0.65 : 0.18

    // ============================================================ Hauteurs de contrôles standard

    readonly property int controlHeightSm: 28
    readonly property int controlHeightMd: 36   // boutons, champs, combobox
    readonly property int controlHeightLg: 44

    // ============================================================ Helpers

    // Convertit le marqueur de raccourci Qt ("&Fichier" → "Fichier" avec F souligné).
    // À utiliser avec textFormat: Text.RichText. Convention Qt :
    //   "&X"  → "<u>X</u>"
    //   "&&"  → "&"  (échappement du caractère "&" littéral)
    function formatMnemonic(text) {
        if (!text) return ""
        return String(text).replace(/&(.)/g, function(match, c) {
            return c === '&' ? '&' : '<u>' + c + '</u>'
        })
    }
}

