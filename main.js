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
    scene.fog = new THREE.Fog(0x87CEEB, 10, 50);

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
    const instructions = document.getElementById('instructions');

    instructions.addEventListener('click', function () {
        controls.lock();
    });

    controls.addEventListener('lock', function () {
        instructions.style.display = 'none';
        blocker.style.display = 'none';
    });

    controls.addEventListener('unlock', function () {
        blocker.style.display = 'flex';
        instructions.style.display = '';
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
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('resize', onWindowResize);

    // Hotbar keys (1-5)
    document.addEventListener('keydown', (event) => {
        const key = parseInt(event.key);
        if (key >= 1 && key <= 5) {
            selectBlock(key - 1);
        }
    });

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

// --- Input Handling ---
function onKeyDown(event) {
    switch (event.code) {
        case 'ArrowUp':
        case 'KeyW':
            moveForward = true;
            break;
        case 'ArrowLeft':
        case 'KeyA':
            moveLeft = true;
            break;
        case 'ArrowDown':
        case 'KeyS':
            moveBackward = true;
            break;
        case 'ArrowRight':
        case 'KeyD':
            moveRight = true;
            break;
        case 'Space':
            if (canJump === true) velocity.y += 15; // Jump strength
            canJump = false;
            break;
    }
}

function onKeyUp(event) {
    switch (event.code) {
        case 'ArrowUp':
        case 'KeyW':
            moveForward = false;
            break;
        case 'ArrowLeft':
        case 'KeyA':
            moveLeft = false;
            break;
        case 'ArrowDown':
        case 'KeyS':
            moveBackward = false;
            break;
        case 'ArrowRight':
        case 'KeyD':
            moveRight = false;
            break;
    }
}

function onMouseDown(event) {
    if (!controls.isLocked) return;

    // Use center of screen for raycasting with pointer lock
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(objects, false);

    if (intersects.length > 0) {
        const intersect = intersects[0];
        
        // Prevent interaction if it's too far (reach is ~5 blocks)
        if (intersect.distance > 5) return;

        // Left Click (Break)
        if (event.button === 0) {
            // Don't break bedrock/bottom layer for safety
            if (intersect.object.position.y > -2) {
                removeBlock(intersect.object);
            }
        } 
        // Right Click (Place)
        else if (event.button === 2) {
            const voxelPos = new THREE.Vector3().copy(intersect.object.position).add(intersect.face.normal);
            // Optional: Check if player intersects with the new block position before placing
            addBlock(Math.round(voxelPos.x), Math.round(voxelPos.y), Math.round(voxelPos.z), currentMaterialType);
        }
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

        direction.z = Number(moveForward) - Number(moveBackward);
        direction.x = Number(moveRight) - Number(moveLeft);
        direction.normalize();

        const speed = 10.0; // Movement speed
        
        // Desired horizontal movement calculated from direction relative to camera
        const moveVec = new THREE.Vector3();
        if (moveForward || moveBackward) moveVec.z = -direction.z * speed * delta;
        if (moveLeft || moveRight) moveVec.x = -direction.x * speed * delta;
        
        // Rotate move vector by camera's Y rotation
        const euler = new THREE.Euler(0, camera.rotation.y, 0, 'YXZ');
        moveVec.applyEuler(euler);

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