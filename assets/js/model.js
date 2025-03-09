import * as THREE from 'three/src/Three.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { HalftonePass } from 'three/addons/postprocessing/HalftonePass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';

let scene, renderer, camera, controls, model, composer;

const defaultSettings = {
  halftone: false,
  autoRotate: true,
  autoRotateSpeed: .01,
  minPolarAngle: deg2rad(15),
  maxPolarAngle:  deg2rad(90),
  maxDistance: 400,
  minDistance: 100,
}

function deg2rad(degrees) {
  return degrees * (Math.PI / 180);
}

/* Control settings */
export function initModel(canvas, modelUrl, replacements, settings) {
  if (settings !== undefined) {
    settings = {...defaultSettings, ...settings}
  } else {
    settings = defaultSettings
  }
  if (canvas === null) {
    console.log('Model canvas is null!');
  }
  //var camera;

  const loader = new GLTFLoader();
  scene = new THREE.Scene();

  loader.load(modelUrl,
    function (gltf) {
      model = gltf.scene;
      model.position.y = -30.0;
      //model.position.y = -1.0;
      scene.add(model);
      //camera = gltf.cameras[Math.floor(Math.random() * gltf.cameras.length)]

      gltf.cameras.forEach(cam => {
        scene.add(cam);
      });

      const light = new THREE.AmbientLight( 0xffffff, 1.8);
      scene.add( light );
      const directionalLight = new THREE.DirectionalLight( 0xffffff, 0.9 );
      scene.add( directionalLight );

      renderer = new THREE.WebGLRenderer({canvas: canvas, antialias: true});
      const parentWidth = renderer.domElement.parentNode.clientWidth;
      const parentHeight = renderer.domElement.parentNode.clientHeight;

      var allCameras = scene.getObjectsByProperty('isCamera', true);
      camera = allCameras[Math.floor(Math.random() * allCameras.length)]

      camera.aspect = parentWidth / parentHeight;
      camera.updateProjectionMatrix();

      const ratio = window.devicePixelRatio || 1;
      renderer.setPixelRatio(ratio);

      renderer.setSize(parentWidth, parentHeight);
      renderer.setAnimationLoop(animate);
      renderer.setClearColor(0xffffff, 0);
      controls = new OrbitControls(camera, renderer.domElement);

      controls.autoRotate = settings.autoRotate;
      controls.autoRotateSpeed = settings.autoRotateSpeed;
      controls.minPolarAngle = settings.minPolarAngle;
      controls.maxPolarAngle = settings.maxPolarAngle;
      controls.maxDistance = settings.maxDistance;
      controls.minDistance = settings.minDistance;

      if (settings.halftone) {
        composer = postprocess(renderer, scene, camera, parentWidth, parentHeight)
      }

      window.addEventListener("resize", () => {
        camera.aspect = canvas.parentNode.clientWidth / canvas.parentNode.clientHeight;
        camera.updateProjectionMatrix();
        if (composer !== undefined) {
          composer.setSize(canvas.parentNode.clientWidth, canvas.parentNode.clientHeight);
        }
        renderer.setSize(canvas.parentNode.clientWidth, canvas.parentNode.clientHeight);
      });

      canvas.scene = scene;

  	},
    undefined,
  	function (error) {
  		console.log('An error happened', error);
  	}
  );

};

function animate() {
  setTimeout( function() {
    requestAnimationFrame( animate );
  }, 1000 / 30 );

	// required if controls.enableDamping or controls.autoRotate are set to true
  if (controls !== undefined) {
	  controls.update();
  }
  if (composer === undefined) {
    renderer.render(scene, camera);
  } else {
    composer.render()
  }
}

function postprocess(renderer, scene, camera, width, height) {
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const params = {
    shape: 1,
    radius: 7,
    rotateR: Math.PI / 12,
    rotateB: Math.PI / 12 * 2,
    rotateG: Math.PI / 12 * 3,
    scatter: 0,
    blending: 1,
    blendingMode: 7,
    greyscale: false,
    disable: false
  };
  const halftonePass = new HalftonePass(width, height, params);
  composer.addPass(renderPass);
  composer.addPass(halftonePass);
  return composer;
}

window.initModel = initModel;
