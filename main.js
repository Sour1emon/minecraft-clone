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
    inventory: 'KeyE',
    breakBlock: 'Mouse0',
    placeBlock: 'Mouse2',
    slot1: 'Digit1',
    slot2: 'Digit2',
    slot3: 'Digit3',
    slot4: 'Digit4',
    slot5: 'Digit5',
    slot6: 'Digit6',
    slot7: 'Digit7',
    slot8: 'Digit8',
    slot9: 'Digit9'
};

let prevTime = performance.now();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// --- Texture Generation ---
const iconUris = {}; // Map block type to base64 image URI for HTML UI

function generateTexture(type) {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    
    // Base colors
    let baseColor, noiseColors;
    if (type === 'dirt') {
        baseColor = [139, 69, 19];
        noiseColors = [[107, 52, 16], [155, 86, 32]];
    } else if (type === 'stone') {
        baseColor = [128, 128, 128];
        noiseColors = [[100, 100, 100], [150, 150, 150]];
    } else if (type === 'grass_top') {
        baseColor = [85, 170, 85];
        noiseColors = [[68, 153, 68], [102, 187, 102]];
    } else if (type === 'wood_top') {
        baseColor = [139, 90, 43];
        noiseColors = [[120, 75, 35], [150, 100, 50]];
    } else if (type === 'sand') {
        baseColor = [238, 214, 175];
        noiseColors = [[200, 180, 140], [255, 230, 190]];
    } else if (type === 'brick') {
        ctx.fillStyle = '#aaa'; // Mortar base
        ctx.fillRect(0,0,16,16);
        ctx.fillStyle = '#b22222'; // Brick red
        // Rows of bricks
        for(let r=0; r<4; r++) {
            let offset = r%2 === 0 ? 0 : -8;
            for(let c=0; c<2; c++) {
                ctx.fillRect(c*16 + offset, r*4, 15, 3);
            }
        }
        for (let i = 0; i < 30; i++) {
            let x = rand(0, 15), y = rand(0, 15);
            ctx.fillStyle = `rgba(0,0,0,0.2)`;
            ctx.fillRect(x,y,1,1);
        }
    } else if (type === 'glass') {
        ctx.clearRect(0,0,16,16);
        ctx.fillStyle = 'rgba(200,220,255,0.4)';
        ctx.fillRect(0,0,16,16);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(0,0,16,2); // Top frame
        ctx.fillRect(0,14,16,2); // Bottom frame
        ctx.fillRect(0,0,2,16); // Left frame
        ctx.fillRect(14,0,2,16); // Right frame
        ctx.fillRect(2,2,4,4); // Glint
    }
    
    if (type === 'grass_side') {
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                // Top a few pixels green, bottom dirt
                let isGrass = y < 4 || (y < 6 && Math.random() > 0.5);
                let c;
                if (isGrass) {
                    c = Math.random() > 0.5 ? [85, 170, 85] : [68, 153, 68];
                } else {
                    c = Math.random() > 0.5 ? [139, 69, 19] : [107, 52, 16];
                }
                ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
                ctx.fillRect(x, y, 1, 1);
            }
        }
    } else if (type === 'wood_side') {
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                let stripe = (x + Math.floor(Math.random()*1.5)) % 4;
                let c = stripe < 2 ? [107, 66, 38] : [74, 46, 27];
                ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
                ctx.fillRect(x, y, 1, 1);
            }
        }
    } else if (type === 'leaves') {
        ctx.fillStyle = `rgb(34, 139, 34)`;
        ctx.fillRect(0, 0, 16, 16);
        for (let i = 0; i < 150; i++) {
            let x = rand(0, 15);
            let y = rand(0, 15);
            let p = Math.random();
            if (p < 0.4) {
                ctx.clearRect(x, y, 1, 1);
            } else {
                ctx.fillStyle = p < 0.7 ? 'rgb(17,119,17)' : 'rgb(50,170,50)';
                ctx.fillRect(x, y, 1, 1);
            }
        }
    } else if (['dirt', 'stone', 'grass_top', 'wood_top', 'sand'].includes(type)) {
        // Standard noise fill
        ctx.fillStyle = `rgb(${baseColor[0]},${baseColor[1]},${baseColor[2]})`;
        ctx.fillRect(0, 0, 16, 16);
        for (let i = 0; i < 150; i++) {
            let x = rand(0, 15);
            let y = rand(0, 15);
            let nc = noiseColors[rand(0, 1)];
            ctx.fillStyle = `rgb(${nc[0]},${nc[1]},${nc[2]})`;
            ctx.fillRect(x, y, 1, 1);
        }
    }
    
    iconUris[type] = canvas.toDataURL(); // Cache for the UI HTML rendering

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter; // Minecraft pixelated look
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const getMat = (type, trans=false) => new THREE.MeshLambertMaterial({ 
    map: generateTexture(type),
    transparent: trans,
    alphaTest: trans ? 0.1 : 0
});

const texDirt = getMat('dirt');
const texGrassTop = getMat('grass_top');
const texGrassSide = getMat('grass_side');
const texStone = getMat('stone');
const texWoodTop = getMat('wood_top');
const texWoodSide = getMat('wood_side');
const texLeaves = getMat('leaves', true);
const texSand = getMat('sand');
const texBrick = getMat('brick');
const texGlass = getMat('glass', true);

// Map complex block types to specific icons for the inventory
iconUris['grass'] = iconUris['grass_side'];
iconUris['wood'] = iconUris['wood_side'];

// BoxGeometry faces: right, left, top, bottom, front, back
const materials = {
    'grass': [texGrassSide, texGrassSide, texGrassTop, texDirt, texGrassSide, texGrassSide],
    'dirt': texDirt,
    'stone': texStone,
    'wood': [texWoodSide, texWoodSide, texWoodTop, texWoodTop, texWoodSide, texWoodSide],
    'leaves': texLeaves,
    'sand': texSand,
    'brick': texBrick,
    'glass': texGlass
};

const blockTypes = ['grass', 'dirt', 'stone', 'wood', 'leaves', 'sand', 'brick', 'glass'];
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

    // Initial UI render
    renderInventory();
    selectHotbarSlot(0);

    // --- World Generation ---
    generateWorld();
}

let inventory = Array(36).fill(null); // 0-8 is hotbar, 9-35 is main inventory
let hotbarSelected = 0; // 0 to 8
let isInventoryOpen = false;

// Give player some starting blocks
inventory[0] = { type: 'grass', count: 64 };
inventory[1] = { type: 'dirt', count: 64 };
inventory[2] = { type: 'stone', count: 64 };
inventory[3] = { type: 'wood', count: 64 };
inventory[4] = { type: 'leaves', count: 64 };
inventory[5] = { type: 'sand', count: 64 };
inventory[6] = { type: 'brick', count: 64 };
inventory[7] = { type: 'glass', count: 64 };

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

    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(objects, false);

    if (intersects.length > 0) {
        const intersect = intersects[0];
        if (intersect.distance > 5) return;

        if (actionName === 'breakBlock') {
            if (intersect.object.position.y > -2) {
                const type = intersect.object.userData.type;
                removeBlock(intersect.object);
                
                let added = false;
                // First pass: look for an existing stack of the same type that is not full
                for (let i = 0; i < 36; i++) {
                    if (inventory[i] && inventory[i].type === type && inventory[i].count < 64) {
                        inventory[i].count++;
                        added = true;
                        break;
                    }
                }
                
                // Second pass: if we couldn't stack it, find the first empty slot
                if (!added) {
                    for (let i = 0; i < 36; i++) {
                        if (!inventory[i]) {
                            inventory[i] = { type: type, count: 1 };
                            break;
                        }
                    }
                }
                
                renderInventory();
            }
        } 
        else if (actionName === 'placeBlock') {
            const item = inventory[hotbarSelected];
            if (item && item.count > 0) {
                const voxelPos = new THREE.Vector3().copy(intersect.object.position).add(intersect.face.normal);
                addBlock(Math.round(voxelPos.x), Math.round(voxelPos.y), Math.round(voxelPos.z), item.type);
                item.count--;
                if (item.count === 0) inventory[hotbarSelected] = null;
                renderInventory();
            }
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
        case keyBinds.inventory:
            toggleInventory();
            break;
        case keyBinds.slot1:
            selectHotbarSlot(0);
            break;
        case keyBinds.slot2:
            selectHotbarSlot(1);
            break;
        case keyBinds.slot3:
            selectHotbarSlot(2);
            break;
        case keyBinds.slot4:
            selectHotbarSlot(3);
            break;
        case keyBinds.slot5:
            selectHotbarSlot(4);
            break;
        case keyBinds.slot6:
            selectHotbarSlot(5);
            break;
        case keyBinds.slot7:
            selectHotbarSlot(6);
            break;
        case keyBinds.slot8:
            selectHotbarSlot(7);
            break;
        case keyBinds.slot9:
            selectHotbarSlot(8);
            break;
    }
}

function toggleInventory() {
    isInventoryOpen = !isInventoryOpen;
    const invScreen = document.getElementById('inventory-screen');
    const blocker = document.getElementById('blocker');
    
    if (isInventoryOpen) {
        controls.unlock();
        invScreen.style.display = 'block';
        blocker.style.display = 'block';
        document.getElementById('menu-main').style.display = 'none'; // Ensure pause menu is hidden
    } else {
        invScreen.style.display = 'none';
        controls.lock();
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

function selectHotbarSlot(index) {
    hotbarSelected = index;
    renderInventory();
}

let selectedInventorySlot = null; // Used for moving items around in inventory

function renderInventory() {
    // 1. Render always-visible bottom hotbar UI
    const hotbarDiv = document.getElementById('hotbar');
    const nameDiv = document.getElementById('hotbar-name');
    hotbarDiv.innerHTML = '';
    
    for (let i = 0; i < 9; i++) {
        const item = inventory[i];
        const slot = document.createElement('div');
        slot.className = `slot ${i === hotbarSelected ? 'active' : ''}`;
        if (item) {
            slot.style.backgroundImage = `url(${iconUris[item.type]})`;
            const countStr = document.createElement('div');
            countStr.className = 'slot-count';
            countStr.innerText = item.count;
            slot.appendChild(countStr);
            if (i === hotbarSelected) nameDiv.innerText = item.type.toUpperCase();
        } else if (i === hotbarSelected) {
            nameDiv.innerText = '';
        }
        hotbarDiv.appendChild(slot);
    }

    // 2. Render Full Inventory Screen if open
    if (isInventoryOpen || true) {
        const invGrid = document.getElementById('inventory-grid');
        const invHotbarGrid = document.getElementById('inventory-hotbar-grid');
        invGrid.innerHTML = '';
        invHotbarGrid.innerHTML = '';

        const setupClick = (slotDiv, index) => {
            slotDiv.addEventListener('click', () => {
                if (selectedInventorySlot === null) {
                    selectedInventorySlot = index; // Pick up
                    renderInventory();
                } else {
                    // Swap
                    const temp = inventory[index];
                    inventory[index] = inventory[selectedInventorySlot];
                    inventory[selectedInventorySlot] = temp;
                    selectedInventorySlot = null; // Drop
                    renderInventory();
                }
            });
        };

        // Render main 27 slots (indices 9 to 35)
        for (let i = 9; i < 36; i++) {
            const item = inventory[i];
            const slot = document.createElement('div');
            slot.className = `inv-slot ${selectedInventorySlot === i ? 'active' : ''}`;
            if (item) {
                slot.style.backgroundImage = `url(${iconUris[item.type]})`;
                const countStr = document.createElement('div');
                countStr.className = 'inv-slot-count';
                countStr.innerText = item.count;
                slot.appendChild(countStr);
            }
            setupClick(slot, i);
            invGrid.appendChild(slot);
        }

        // Render hotbar 9 slots in inventory screen (indices 0 to 8)
        for (let i = 0; i < 9; i++) {
            const item = inventory[i];
            const slot = document.createElement('div');
            slot.className = `inv-slot ${selectedInventorySlot === i ? 'active' : ''}`;
            if (item) {
                slot.style.backgroundImage = `url(${iconUris[item.type]})`;
                const countStr = document.createElement('div');
                countStr.className = 'inv-slot-count';
                countStr.innerText = item.count;
                slot.appendChild(countStr);
            }
            setupClick(slot, i);
            invHotbarGrid.appendChild(slot);
        }
    }
}

// Ensure context menu doesn't appear on right click
document.addEventListener('contextmenu', event => event.preventDefault());

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
        
        // When Pitching up/down, camera's local X-axis (Right) is unaffected. 
        // We use it to reliably extract horizontal Forward and Right vectors regardless of Gimbal lock.
        const right = new THREE.Vector3();
        right.setFromMatrixColumn(camera.matrix, 0);
        right.y = 0;
        right.normalize();

        const front = new THREE.Vector3();
        front.crossVectors(new THREE.Vector3(0, 1, 0), right).normalize();

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