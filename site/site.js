/* ═══════════════════════════════════════════
   SHARED STATE
═══════════════════════════════════════════ */
const M = { x: innerWidth/2, y: innerHeight/2 };

/* ═══════════════════════════════════════════
   CUSTOM CURSOR
═══════════════════════════════════════════ */
(function(){
  const dot = document.getElementById('cdot');
  const ring = document.getElementById('cring');
  if(!dot||!ring)return;
  if(window.matchMedia('(pointer:coarse)').matches) return;
  let rx=M.x,ry=M.y;
  document.addEventListener('mousemove',e=>{
    M.x=e.clientX; M.y=e.clientY;
    dot.style.transform=`translate(${M.x-3}px,${M.y-3}px)`;
  });
  (function anim(){
    rx+=(M.x-rx)*.1; ry+=(M.y-ry)*.1;
    ring.style.transform=`translate(${rx-19}px,${ry-19}px)`;
    requestAnimationFrame(anim);
  })();
  document.querySelectorAll('a,button,.mn,.titem,.cc,.nav-btn,.btn-p,.btn-g,.faq-q,.nav-link').forEach(el=>{
    el.addEventListener('mouseenter',()=>document.body.classList.add('chov'));
    el.addEventListener('mouseleave',()=>document.body.classList.remove('chov'));
  });
})();

/* ═══════════════════════════════════════════
   WEBGL BACKGROUND SHADER
═══════════════════════════════════════════ */
(function(){
  const cv=document.getElementById('bg');
  if(!cv)return;
  const gl=cv.getContext('webgl')||cv.getContext('experimental-webgl');
  if(!gl)return;
  const vs=`attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}`;
  const fs=`
    precision highp float;
    uniform vec2 u_r; uniform float u_t; uniform vec2 u_m;
    vec2 h2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453)*2.-1.;}
    float gn(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(dot(h2(i),f),dot(h2(i+vec2(1,0)),f-vec2(1,0)),u.x),mix(dot(h2(i+vec2(0,1)),f-vec2(0,1)),dot(h2(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);}
    mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
    float fbm(vec2 p,float t){float v=0.,a=.55;p+=vec2(t*.09,t*.07);for(int i=0;i<6;i++){v+=a*gn(p);p=rot(.35)*p*2.1+vec2(1.7+t*.02,9.2-t*.02);a*=.48;}return v;}
    void main(){
      vec2 uv=gl_FragCoord.xy/u_r; uv.y=1.-uv.y; float t=u_t*.22;
      vec2 mv=u_m/u_r; mv.y=1.-mv.y;
      vec2 d=mv-uv; float md=length(d);
      vec2 wuv=uv+d*exp(-md*3.)*0.2;
      vec2 q=vec2(fbm(wuv*1.7,t),fbm(wuv*1.7+vec2(5.2,1.3),t));
      vec2 r=vec2(fbm(wuv*1.9+4.*q+vec2(1.7,9.2),t+.15),fbm(wuv*1.9+4.*q+vec2(8.3,2.8),t+.12));
      float f=fbm(uv*2.1+4.*r,t)*.5+.5;
      float mg=exp(-md*4.5)*.85;
      vec3 c0=vec3(.031,.031,.063),c1=vec3(.04,.04,.32),c2=vec3(.102,.102,1.),c3=vec3(.2,.2,1.);
      vec3 col=mix(c0,c1,smoothstep(.1,.45,f));
      col=mix(col,c2,smoothstep(.38,.72,f));
      col=mix(col,c3,smoothstep(.65,.9,f)*.55);
      col=mix(col,c2,mg*(f*.4+.15));
      col+=c3*mg*.35*smoothstep(.4,1.,f);
      float v=1.-.52*dot((uv-.5)*vec2(1.,1.6),(uv-.5)*vec2(1.,1.6));
      col*=v; col+=c1*.18*(1.-uv.y);
      gl_FragColor=vec4(clamp(col,0.,1.),1.);
    }`;
  function mkShader(t,s){const sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);return sh;}
  const prog=gl.createProgram();
  gl.attachShader(prog,mkShader(gl.VERTEX_SHADER,vs));
  gl.attachShader(prog,mkShader(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const aloc=gl.getAttribLocation(prog,'p'); gl.enableVertexAttribArray(aloc);
  gl.vertexAttribPointer(aloc,2,gl.FLOAT,false,0,0);
  const uR=gl.getUniformLocation(prog,'u_r'),uT=gl.getUniformLocation(prog,'u_t'),uMo=gl.getUniformLocation(prog,'u_m');
  function resize(){cv.width=innerWidth;cv.height=innerHeight;gl.viewport(0,0,cv.width,cv.height);}
  window.addEventListener('resize',resize); resize();
  let t0=null;
  (function frame(ts){if(!t0)t0=ts;gl.uniform2f(uR,cv.width,cv.height);gl.uniform1f(uT,(ts-t0)/1000);gl.uniform2f(uMo,M.x,M.y);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);requestAnimationFrame(frame);})();
})();

/* ═══════════════════════════════════════════
   GENERAL SCROLL REVEAL
═══════════════════════════════════════════ */
(function(){
  const obs=new IntersectionObserver(entries=>{
    entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('vis');}});
  },{threshold:.08});
  document.querySelectorAll('.rv').forEach(el=>obs.observe(el));
})();

/* ═══════════════════════════════════════════
   MOBILE NAV TOGGLE
═══════════════════════════════════════════ */
(function(){
  const btn=document.getElementById('navToggle');
  const drawer=document.getElementById('navDrawer');
  if(!btn||!drawer)return;
  btn.addEventListener('click',()=>{
    const open=drawer.classList.toggle('open');
    btn.setAttribute('aria-expanded',open);
  });
  drawer.querySelectorAll('a').forEach(a=>{
    a.addEventListener('click',()=>{
      drawer.classList.remove('open');
      btn.setAttribute('aria-expanded','false');
    });
  });
})();
