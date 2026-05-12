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

    // 3. Interactive Canvas Background
    const canvas = document.getElementById('bg-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        let width, height;
        let particles = [];

        function resize() {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
        }

        window.addEventListener('resize', resize);
        resize();

        class Particle {
            constructor() {
                this.x = Math.random() * width;
                this.y = Math.random() * height;
                this.vx = (Math.random() - 0.5) * 0.7; 
                this.vy = (Math.random() - 0.5) * 0.7;
                this.radius = Math.random() * 1.5 + 0.5;
            }

            update() {
                this.x += this.vx;
                this.y += this.vy;
                if (this.x < 0 || this.x > width) this.vx *= -1;
                if (this.y < 0 || this.y > height) this.vy *= -1;
            }

            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 243, 255, 0.6)';
                ctx.fill();
            }
        }

        for (let i = 0; i < 60; i++) {
            particles.push(new Particle());
        }

        function animate() {
            ctx.clearRect(0, 0, width, height);
            particles.forEach(p => {
                p.update();
                p.draw();
            });

            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const dx = particles[i].x - particles[j].x;
                    const dy = particles[i].y - particles[j].y;
                    const distance = Math.sqrt(dx * dx + dy * dy);

                    if (distance < 130) {
                        ctx.beginPath();
                        const opacity = 1 - (distance / 130);
                        ctx.strokeStyle = `rgba(188, 19, 254, ${opacity * 0.5})`;
                        ctx.lineWidth = 0.5;
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.stroke();
                    }
                }
            }
            requestAnimationFrame(animate);
        }
        animate();
    }
});
