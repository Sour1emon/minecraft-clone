import { startGame } from "./src/babylon/game.js";

function showErrorOverlay(err) {
	try {
		const pre = document.createElement('pre');
		pre.id = 'js-error-overlay';
		pre.style.position = 'fixed';
		pre.style.left = '8px';
		pre.style.top = '8px';
		pre.style.padding = '8px';
		pre.style.background = 'rgba(0,0,0,0.85)';
		pre.style.color = 'white';
		pre.style.zIndex = 9999;
		pre.style.maxWidth = '60%';
		pre.style.maxHeight = '60%';
		pre.style.overflow = 'auto';
		pre.textContent = String(err && (err.stack || err.message || err));
		document.body.appendChild(pre);
	} catch (e) {
        
		// ignore overlay errors
	}
	console.error(err);
}

startGame().catch(showErrorOverlay);
