// Dev-only re-export so a runtime eval can load three's FBXLoader (which uses
// bare specifiers Vite must resolve). Not imported by the app.
export { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
