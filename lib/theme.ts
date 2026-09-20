export const THEME_STORAGE_KEY = "ripple-theme";

export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;}}catch(e){}})();`;
