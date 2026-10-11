// Bundled rather than fetched from a font service, so the console makes no third-party request. Only
// the weights the themes use. A browser downloads a face only when text on the page is set in it, so
// the Default look fetches none of these until the switcher's swatches show each theme's heading face.
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/700.css';
import '@fontsource/archivo/400.css';
import '@fontsource/archivo/500.css';
import '@fontsource/archivo/700.css';
import '@fontsource/domine/400.css';
import '@fontsource/jetbrains-mono/400.css';
