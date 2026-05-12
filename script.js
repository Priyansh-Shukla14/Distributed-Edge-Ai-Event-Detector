// Ensure script runs after the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {

    // 1. Initialize Mini Waveforms for Node Cards
    const waveforms = document.querySelectorAll('.waveform-mini');
    if (waveforms.length > 0) {
        waveforms.forEach(container => {
            for(let i = 0; i < 7; i++) {
                const bar = document.createElement('div');
                bar.className = 'wave-bar';
                bar.style.animationDuration = (0.6 + Math.random() * 0.6) + 's';
                bar.style.animationDelay = (i * 0.1) + 's';
                container.appendChild(bar);
            }
        });
    }

    // 2. Simulate Live Data Updates for Nodes
    const node1Text = document.getElementById('node1-conf-text');
    if (node1Text) {
        setInterval(() => {
            const conf1 = Math.floor(Math.random() * 14) + 85; 
            document.getElementById('node1-conf-text').innerText = conf1 + '%';
            document.getElementById('node1-conf-fill').style.width = conf1 + '%';

            const conf2 = Math.floor(Math.random() * 21) + 75; 
            document.getElementById('node2-conf-text').innerText = conf2 + '%';
            document.getElementById('node2-conf-fill').style.width = conf2 + '%';
        }, 3500);
    }

});
