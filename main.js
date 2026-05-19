import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

// --- Global Variables ---
let camera, scene, renderer, controls;
let raycaster;

// Rapier Physics
let world, characterController, playerBody, playerCollider;

// Movement & Physics
const objects = []; // Array of interactable blocks
const blockMap = new Map(); // "x,y,z" -> mesh for fast lookup
let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let canJump = false;

let renderDistance = 50;
let isRebinding = false; // Flag to stop other key interactions while waiting for a key press

// Keybind settings mapping action to actual event.code or mouse button
const keyBinds = {
    forward: 'KeyW',
    backward: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    jump: 'Space',
    breakBlock: 'Mouse0',
    placeBlock: 'Mouse2',
    slot1: 'Digit1',
    slot2: 'Digit2',
    slot3: 'Digit3',
    slot4: 'Digit4',
    slot5: 'Digit5'
};

let prevTime = performance.now();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// Block Types & Materials
const textureLoader = new THREE.TextureLoader();
// Using simple colors for now instead of textures for immediate preview without CORS issues
const materials = {
    'grass': new THREE.MeshLambertMaterial({ color: 0x55aa55 }),
    'dirt': new THREE.MeshLambertMaterial({ color: 0x8B4513 }),
    'stone': new THREE.MeshLambertMaterial({ color: 0x808080 }),
    'wood': new THREE.MeshLambertMaterial({ color: 0x8b5a2b }),
    'leaves': new THREE.MeshLambertMaterial({ color: 0x228b22 })
};
const blockTypes = ['grass', 'dirt', 'stone', 'wood', 'leaves'];
let currentMaterialType = 'grass';

const blockGeometry = new THREE.BoxGeometry(1, 1, 1);

// Highlight / Selection Box
let rollOverMesh;

init().then(animate);

async function init() {
    // --- Physics Setup ---
    await RAPIER.init();
    world = new RAPIER.World(new RAPIER.Vector3(0.0, -30.0, 0.0));

    // --- Scene Setup ---
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Sky blue
    scene.fog = new THREE.Fog(0x87CEEB, 10, renderDistance);

    // --- Lighting ---
    const ambientLight = new THREE.AmbientLight(0xeeeeee, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 20, 10);
    scene.add(directionalLight);

    // --- Camera & Renderer ---
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // --- Controls ---
    controls = new PointerLockControls(camera, renderer.domElement);
    
    const blocker = document.getElementById('blocker');
    
    // Menu panels
    const menuMain = document.getElementById('menu-main');
    const menuOptions = document.getElementById('menu-options');
    const menuGraphics = document.getElementById('menu-graphics');
    const menuControls = document.getElementById('menu-controls');

    // UI functions
    function showMenu(menu) {
        menuMain.style.display = 'none';
        menuOptions.style.display = 'none';
        menuGraphics.style.display = 'none';
        menuControls.style.display = 'none';
        menu.style.display = 'flex';
    }

    // Main pause menu
    document.getElementById('btn-resume').addEventListener('click', () => controls.lock());
    document.getElementById('btn-options').addEventListener('click', () => showMenu(menuOptions));
    document.getElementById('btn-exit').addEventListener('click', () => {
        clearWorld();
        generateWorld();
        controls.lock(); // Optionally restart immediately
    });

    // Options menu
    document.getElementById('btn-graphics').addEventListener('click', () => showMenu(menuGraphics));
    document.getElementById('btn-controls').addEventListener('click', () => showMenu(menuControls));
    document.getElementById('btn-options-done').addEventListener('click', () => showMenu(menuMain));

    // Graphics Menu
    const sliderRenderDist = document.getElementById('graphics-render-distance');
    const lblRenderDist = document.getElementById('lbl-render-distance');
    sliderRenderDist.addEventListener('input', (e) => {
        renderDistance = parseInt(e.target.value);
        lblRenderDist.innerText = `${renderDistance} chunks`;
        scene.fog.far = renderDistance;
    });
    document.getElementById('btn-graphics-done').addEventListener('click', () => showMenu(menuOptions));

    // Controls Menu KeyBinding Logic
    document.querySelectorAll('.keybind-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            isRebinding = true;
            const targetBtn = e.target;
            const action = targetBtn.getAttribute('data-action');
            targetBtn.innerText = '>'; // Visual cue
            
            const handleBindKey = (ev) => {
                ev.preventDefault();
                finalizeBind(ev.code, ev.code === 'Space' ? 'SPACE' : ev.code.replace('Key', ''));
            };
            
            const handleBindMouse = (ev) => {
                ev.preventDefault();
                let name = 'Click L';
                if (ev.button === 1) name = 'Click M';
                if (ev.button === 2) name = 'Click R';
                finalizeBind('Mouse' + ev.button, name);
            };

            const finalizeBind = (code, display) => {
                keyBinds[action] = code;
                targetBtn.innerText = display;
                document.removeEventListener('keydown', handleBindKey);
                document.removeEventListener('mousedown', handleBindMouse);
                // Delay dropping the flag so the binding click itself doesn't trigger an in-game action
                setTimeout(() => { isRebinding = false; }, 50);
            };

            // Use setTimeout so the current click doesn't trigger the mousedown listener instantly
            setTimeout(() => {
                document.addEventListener('keydown', handleBindKey);
                document.addEventListener('mousedown', handleBindMouse);
            }, 10);
        });
    });
    document.getElementById('btn-controls-done').addEventListener('click', () => showMenu(menuOptions));


    controls.addEventListener('lock', function () {
        blocker.style.display = 'none';
    });

    controls.addEventListener('unlock', function () {
        blocker.style.display = 'flex';
        showMenu(menuMain); // Reset back to main pause context
    });

    scene.add(controls.getObject());
    
    // Create player physics body
    const playerDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 5, 0);
    playerBody = world.createRigidBody(playerDesc);
    const colliderDesc = RAPIER.ColliderDesc.capsule(0.8, 0.4); // height/2, radius
    playerCollider = world.createCollider(colliderDesc, playerBody);
    characterController = world.createCharacterController(0.01);
    characterController.enableAutostep(0.5, 0.2, true);
    characterController.enableSnapToGround(0.5);

    controls.getObject().position.y = 5; // Spawn height

    // --- Event Listeners ---
    document.addEventListener('keydown', (e) => {
        if (!isRebinding) onInputDown(e.code);
    });
    document.addEventListener('keyup', (e) => {
        if (!isRebinding) onInputUp(e.code);
    });
    document.addEventListener('mousedown', (e) => {
        if (!isRebinding) onInputDown('Mouse' + e.button);
    });
    document.addEventListener('mouseup', (e) => {
        if (!isRebinding) onInputUp('Mouse' + e.button);
    });
    window.addEventListener('resize', onWindowResize);

    // --- Raycaster & RollOver (Highlight) ---
    raycaster = new THREE.Raycaster();
    
    const rollOverGeo = new THREE.EdgesGeometry(blockGeometry);
    const rollOverMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 });
    rollOverMesh = new THREE.LineSegments(rollOverGeo, rollOverMaterial);
    scene.add(rollOverMesh);

    // --- World Generation ---
    generateWorld();
}

function generateWorld() {
    // Generate a simple 20x20 flat grid
    const gridSize = 20;
    for (let x = -gridSize / 2; x < gridSize / 2; x++) {
        for (let z = -gridSize / 2; z < gridSize / 2; z++) {
            // Bedrock / Bottom layer (stone)
            addBlock(x, -2, z, 'stone');
            
            // Dirt layer
            addBlock(x, -1, z, 'dirt');
            
            // Surface layer
            addBlock(x, 0, z, 'grass');
        }
    }
}

function addBlock(x, y, z, type) {
    const mesh = new THREE.Mesh(blockGeometry, materials[type]);
    mesh.position.set(x, y, z);
    mesh.userData = { type: type };
    
    // Add physics collider for this block
    const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    const rigidBody = world.createRigidBody(rigidBodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5); // Half-extents
    const collider = world.createCollider(colliderDesc, rigidBody);
    mesh.userData.rigidBody = rigidBody;

    // Add wireframe to make blocks distinguishable
    const edges = new THREE.EdgesGeometry(blockGeometry);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, opacity: 0.1, transparent: true }));
    mesh.add(line);

    scene.add(mesh);
    objects.push(mesh);
    blockMap.set(`${x},${y},${z}`, mesh);
    return mesh;
}

function removeBlock(mesh) {
    if (mesh.userData.rigidBody) {
        world.removeRigidBody(mesh.userData.rigidBody);
    }
    const pos = mesh.position;
    blockMap.delete(`${pos.x},${pos.y},${pos.z}`);
    scene.remove(mesh);
    const index = objects.indexOf(mesh);
    if (index > -1) {
        objects.splice(index, 1);
    }
}

function clearWorld() {
    // Clear out map backwards to avoid splicing issues
    while (objects.length > 0) {
        removeBlock(objects[0]);
    }
    blockMap.clear();
    
    // Reset player to origin
    playerBody.setTranslation(new RAPIER.Vector3(0, 5, 0), true);
    velocity.set(0,0,0);
}

function performInteract(actionName) {
    if (!controls.isLocked) return;

    // Use center of screen for raycasting with pointer lock
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(objects, false);

    if (intersects.length > 0) {
        const intersect = intersects[0];
        
        // Prevent interaction if it's too far (reach is ~5 blocks)
        if (intersect.distance > 5) return;

        if (actionName === 'breakBlock') {
            // Don't break bedrock/bottom layer for safety
            if (intersect.object.position.y > -2) {
                removeBlock(intersect.object);
            }
        } 
        else if (actionName === 'placeBlock') {
            const voxelPos = new THREE.Vector3().copy(intersect.object.position).add(intersect.face.normal);
            // Optional: Check if player intersects with the new block position before placing
            addBlock(Math.round(voxelPos.x), Math.round(voxelPos.y), Math.round(voxelPos.z), currentMaterialType);
        }
    }
}

// --- Input Handling ---
function onInputDown(inputStr) {
    switch (inputStr) {
        case keyBinds.forward:
            moveForward = true;
            break;
        case keyBinds.left:
            moveLeft = true;
            break;
        case keyBinds.backward:
            moveBackward = true;
            break;
        case keyBinds.right:
            moveRight = true;
            break;
        case keyBinds.jump:
            if (canJump === true) velocity.y += 15; // Jump strength
            canJump = false;
            break;
        case keyBinds.breakBlock:
            performInteract('breakBlock');
            break;
        case keyBinds.placeBlock:
            performInteract('placeBlock');
            break;
        case keyBinds.slot1:
            selectBlock(0);
            break;
        case keyBinds.slot2:
            selectBlock(1);
            break;
        case keyBinds.slot3:
            selectBlock(2);
            break;
        case keyBinds.slot4:
            selectBlock(3);
            break;
        case keyBinds.slot5:
            selectBlock(4);
            break;
    }
}

function onInputUp(inputStr) {
    switch (inputStr) {
        case keyBinds.forward:
            moveForward = false;
            break;
        case keyBinds.left:
            moveLeft = false;
            break;
        case keyBinds.backward:
            moveBackward = false;
            break;
        case keyBinds.right:
            moveRight = false;
            break;
    }
}

// Ensure context menu doesn't appear on right click
document.addEventListener('contextmenu', event => event.preventDefault());

function selectBlock(index) {
    currentMaterialType = blockTypes[index];
    // Update UI
    const slots = document.querySelectorAll('.slot');
    slots.forEach(slot => slot.classList.remove('active'));
    if (slots[index]) {
        slots[index].classList.add('active');
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Main Loop & Physics ---
function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();

    if (controls.isLocked === true) {
        // Highlighting / RollOver update
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const intersects = raycaster.intersectObjects(objects, false);
        
        if (intersects.length > 0 && intersects[0].distance <= 5) {
            const intersect = intersects[0];
            const voxelPos = new THREE.Vector3().copy(intersect.object.position).add(intersect.face.normal);
            rollOverMesh.position.copy(voxelPos);
            rollOverMesh.visible = true;
        } else {
            rollOverMesh.visible = false;
        }

        // Movement Physics
        const delta = Math.min((time - prevTime) / 1000, 0.1); // Cap delta to prevent huge jumps

        velocity.x -= velocity.x * 10.0 * delta;
        velocity.z -= velocity.z * 10.0 * delta;

        // Apply jump velocity manually since we use kinematic character controller
        velocity.y -= 30 * delta; // Gravity

        const speed = 10.0; // Movement speed
        
        // Calculate forward and right vectors based on where the camera is facing
        const front = new THREE.Vector3();
        controls.getDirection(front);
        front.y = 0; // Keep movement purely horizontal
        front.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(front, new THREE.Vector3(0, 1, 0)).normalize();

        const moveVec = new THREE.Vector3();
        if (moveForward) moveVec.add(front);
        if (moveBackward) moveVec.sub(front);
        if (moveLeft) moveVec.sub(right);
        if (moveRight) moveVec.add(right);

        // Normalize so diagonal movement isn't faster, then apply speed
        if (moveVec.lengthSq() > 0) {
            moveVec.normalize().multiplyScalar(speed * delta);
        }

        // Compute desired movement including gravity/jump
        const desiredMovement = new RAPIER.Vector3(
            moveVec.x,
            velocity.y * delta,
            moveVec.z
        );

        // Compute colliding movement
        characterController.computeColliderMovement(
            playerCollider,
            desiredMovement,
        );

        const computedMovement = characterController.computedMovement();
        
        // Correct velocity based on actual movement (e.g. hitting ground stops falling)
        if (characterController.computedGrounded()) {
            canJump = true;
            if (velocity.y < 0) velocity.y = 0;
        }

        // Apply computed movement to player body and camera
        const nextPos = playerBody.translation();
        nextPos.x += computedMovement.x;
        nextPos.y += computedMovement.y;
        nextPos.z += computedMovement.z;
        playerBody.setNextKinematicTranslation(nextPos);

        // Step simulation
        world.step();

        // Update camera position to match physics body
        const pos = playerBody.translation();
        controls.getObject().position.set(pos.x, pos.y + 0.8, pos.z); // Adjust camera height above capsule center
    }

    prevTime = time;
    renderer.render(scene, camera);
}