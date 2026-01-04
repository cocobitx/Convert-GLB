const $log = id => document.getElementById(id);
const log = (s)=> { $log('log').textContent += s + "\n"; $log('log').scrollTop = $log('log').scrollHeight; }

let filesMap = {}; // name -> Uint8Array

document.getElementById('loadZip').addEventListener('click', async ()=>{
  const f = document.getElementById('zipInput').files[0];
  if(!f){ alert('Selecciona un ZIP.'); return; }
  filesMap = {};
  log("Leyendo ZIP...");
  const jszip = new JSZip();
  const zip = await jszip.loadAsync(f);
  const names = Object.keys(zip.files);
  for(const name of names){
    if(zip.files[name].dir) continue;
    const data = await zip.files[name].async('uint8array');
    const key = name.split('/').pop(); // keep basename
    filesMap[key] = data;
    log("Cargado: " + name + " (" + data.length + " bytes)");
  }
});

document.getElementById('filesInput').addEventListener('change', (ev)=>{
  filesMap = filesMap || {};
  for(const f of ev.target.files){
    const reader = new FileReader();
    reader.onload = (e)=>{
      filesMap[f.name] = new Uint8Array(e.target.result);
      log("Añadido: " + f.name + " (" + filesMap[f.name].length + " bytes)");
    };
    reader.readAsArrayBuffer(f);
  }
});

function uint8ToString(u8){
  try {
    return new TextDecoder('utf-8', {fatal:false}).decode(u8);
  } catch(e){
    return new TextDecoder('latin1').decode(u8);
  }
}

function tryGzipDecompress(u8){
  // detect gzip header 0x1f 0x8b 0x08
  if(u8.length > 3 && u8[0] === 0x1f && u8[1] === 0x8b && u8[2] === 0x08){
    try {
      const dec = pako.ungzip(u8);
      return dec;
    } catch(e){
      log("Error descomprimiendo gzip: " + e);
      return null;
    }
  } else {
    return u8; // not gzip
  }
}

function computeNormals(positions, indices){
  const nverts = positions.length / 3;
  const normals = new Float32Array(nverts*3);
  for(let i=0;i<indices.length;i+=3){
    const ia = indices[i], ib = indices[i+1], ic = indices[i+2];
    const ax = positions[3*ia], ay = positions[3*ia+1], az = positions[3*ia+2];
    const bx = positions[3*ib], by = positions[3*ib+1], bz = positions[3*ib+2];
    const cx = positions[3*ic], cy = positions[3*ic+1], cz = positions[3*ic+2];
    const v1x = bx-ax, v1y = by-ay, v1z = bz-az;
    const v2x = cx-ax, v2y = cy-ay, v2z = cz-az;
    const nx = v1y*v2z - v1z*v2y;
    const ny = v1z*v2x - v1x*v2z;
    const nz = v1x*v2y - v1y*v2x;
    normals[3*ia]   += nx; normals[3*ia+1] += ny; normals[3*ia+2] += nz;
    normals[3*ib]   += nx; normals[3*ib+1] += ny; normals[3*ib+2] += nz;
    normals[3*ic]   += nx; normals[3*ic+1] += ny; normals[3*ic+2] += nz;
  }
  // normalize
  for(let v=0; v<nverts; v++){
    let nx = normals[3*v], ny = normals[3*v+1], nz = normals[3*v+2];
    const len = Math.hypot(nx,ny,nz);
    if(len > 1e-9){ normals[3*v]=nx/len; normals[3*v+1]=ny/len; normals[3*v+2]=nz/len; }
    else { normals[3*v]=0; normals[3*v+1]=0; normals[3*v+2]=1; }
  }
  return normals;
}

function pad4(buf){
  const pad = (4 - (buf.byteLength % 4)) % 4;
  if(pad === 0) return buf;
  const a = new Uint8Array(buf.byteLength + pad);
  a.set(new Uint8Array(buf));
  return a.buffer;
}

function concatArrayBuffers(buffers){
  let total = 0;
  for(const b of buffers) total += b.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for(const b of buffers){
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

function writeGLB(jsonObj, binBuffer){
  const jsonText = JSON.stringify(jsonObj);
  let jsonBuf = new TextEncoder().encode(jsonText);
  // pad JSON to 4
  if(jsonBuf.byteLength % 4 !== 0){
      const pad = 4 - (jsonBuf.byteLength % 4);
      const tmp = new Uint8Array(jsonBuf.byteLength + pad);
      tmp.set(jsonBuf);

      // <-- esta parte es la CORRECCIÓN -->
      for(let i = jsonBuf.byteLength; i < tmp.length; i++){
          tmp[i] = 0x20;  // espacio, NO 0x00
      }

      jsonBuf = tmp;
  }
  // BIN already should be padded
  const binBuf = binBuffer;
  const totalLen = 12 + 8 + jsonBuf.byteLength + 8 + binBuf.byteLength;
  const header = new ArrayBuffer(12);
  const headerView = new DataView(header);
  headerView.setUint32(0, 0x46546C67, true); // 'glTF'
  headerView.setUint32(4, 2, true);
  headerView.setUint32(8, totalLen, true);

  const jsonChunkHeader = new ArrayBuffer(8);
  const jch = new DataView(jsonChunkHeader);
  jch.setUint32(0, jsonBuf.byteLength, true);
  jch.setUint32(4, 0x4E4F534A, true); // 'JSON'

  const binChunkHeader = new ArrayBuffer(8);
  const bch = new DataView(binChunkHeader);
  bch.setUint32(0, binBuf.byteLength, true);
  bch.setUint32(4, 0x004E4942, true); // 'BIN\0'

  return concatArrayBuffers([header, jsonChunkHeader, jsonBuf.buffer, binChunkHeader, binBuf]);
}

document.getElementById('convertBtn').addEventListener('click', async ()=>{
  try {
    if(!filesMap || Object.keys(filesMap).length===0){ alert('No has cargado archivos.'); return; }
    log("Iniciando conversión...");

    // Find model and material files (by extension)
    let modelName = Object.keys(filesMap).find(n => n.toLowerCase().endsWith('.model'));
    let materialName = Object.keys(filesMap).find(n => n.toLowerCase().endsWith('.material'));
    if(!modelName){ alert('No se encontró .model'); return; }
    log("Modelo detectado: " + modelName);
    // get raw bytes
    let modelRaw = filesMap[modelName];
    let materialRaw = materialName ? filesMap[materialName] : null;

    // decompress if gzip
    const modelDec = tryGzipDecompress(modelRaw);
    if(!modelDec){ alert('Error al descomprimir model'); return; }
    log("Modelo descomprimido: " + modelDec.byteLength + " bytes");

    let modelText = uint8ToString(modelDec);
    // Some .model are JSON straight; some binary with embedded JSON. Try parsing whole text
    let modelJson = null;
    try {
      modelJson = JSON.parse(modelText);
      log("El .model contiene JSON parseable directamente.");
    } catch(e) {
      // try to find a JSON substring inside the binary
      const text = uint8ToString(modelDec);
      const match = text.match(/\{[\s\S]*"geometry"[\s\S]*?\}/);
      if(match){
        modelJson = JSON.parse(match[0]);
        log("Encontrado JSON embebido en .model y parseado.");
      } else {
        throw new Error("No se pudo extraer JSON del .model");
      }
    }

    // material
    let materialJson = null;
    if(materialRaw){
      const matDec = tryGzipDecompress(materialRaw);
      if(!matDec){ log("Warning: no se pudo descomprimir material."); }
      else {
        const matText = uint8ToString(matDec);
        try { materialJson = JSON.parse(matText); log("material parseado."); }
        catch(e){ log("No se pudo parsear material como JSON."); }
      }
    } else {
      log("No se subió archivo .material — se usará material simple.");
    }

    // Parse geometry: (we assume same layout como en viewer: geometry[""] with position, uv, index, groups)
    const geom = modelJson.geometry[""] || modelJson.geometry[Object.keys(modelJson.geometry)[0]];
    if(!geom) throw new Error("No se encontró geometry en el JSON.");
    const positions = Float32Array.from(geom.position || []);
    const uvs = Float32Array.from(geom.uv || []);
    const indices = Uint32Array.from(geom.index || []); // may be large
    log(`Vertices: ${positions.length/3}, UVs: ${uvs.length/2}, Indices: ${indices.length}`);

    // Normals: if exist in model JSON use them, else compute
    let normals = null;
    if(geom.normal && geom.normal.length === positions.length){
      normals = Float32Array.from(geom.normal);
      log("Normales leídas del JSON.");
    } else {
      log("Calculando normales...");
      normals = computeNormals(positions, indices);
    }

    // Build binary buffer: positions, normals, uvs, indices
    const posBytes = new Uint8Array(positions.buffer.slice(0)); // little-endian already from Float32Array
    const norBytes = new Uint8Array(normals.buffer.slice(0));
    const uvBytes  = new Uint8Array(uvs.buffer.slice(0));

    // indices -> choose 16 or 32 bit
    let indexBytes, indexComponentType;
    if (indices.length <= 65535) {
      // use uint16
      const idx16 = new Uint16Array(indices);
      indexBytes = new Uint8Array(idx16.buffer.slice(0));
      indexComponentType = 5123; // UNSIGNED_SHORT
      log("Usando índices UNSIGNED_SHORT.");
    } else {
      const idx32 = new Uint32Array(indices);
      indexBytes = new Uint8Array(idx32.buffer.slice(0));
      indexComponentType = 5125; // UNSIGNED_INT
      log("Usando índices UNSIGNED_INT.");
    }

    // We'll append textures after geometry; keep track of views
    const images = [];
    const textures = [];
    const bufferViews = [];
    const accessors = [];

    // We'll maintain binParts and cursor; create addPart to ensure offsets match bufferViews
    const binParts = [];
    let cursor = 0;

    function addPart(u8, target=null){
      // u8 must be Uint8Array
      if(!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
      const byteOffset = cursor;
      const byteLength = u8.byteLength;
      const bv = { buffer: 0, byteOffset, byteLength };
      if(target) bv.target = target;
      bufferViews.push(bv);
      // push actual data
      binParts.push(u8);
      cursor += byteLength;
      // pad to 4 bytes
      const pad = (4 - (cursor % 4)) % 4;
      if(pad > 0){
        binParts.push(new Uint8Array(pad)); // zeros
        cursor += pad;
      }
      return bufferViews.length - 1; // index of the bufferView we just added
    }

    // Add geometry parts using addPart so bufferViews indices are consistent
    const bvPos = addPart(posBytes, 34962);
    const posLen = posBytes.byteLength;
    const bvNorm = addPart(norBytes, 34962);
    const norLen = norBytes.byteLength;
    const bvUV = addPart(uvBytes, 34962);
    const uvLen = uvBytes.byteLength;
    const bvIdx = addPart(indexBytes, 34963);
    const idxLen = indexBytes.byteLength;

    // Now process textures declared in materialJson
    // materialJson structure: {version:..., materials: { "": { default: [ { map: 'path', normalMap: 'path', emissiveMap: 'path' }, ... ] } } }
    // We'll look up the first material entry and its fields
    let firstMat = null;
    if(materialJson){
      outer:
      for(const key in materialJson.materials){
        const val = materialJson.materials[key];
        if(Array.isArray(val)){
          firstMat = val[0];
          break;
        }
        // Sometimes the structure is { "": { default: [ ... ] } }
        if(typeof val === 'object'){
          if(val.default && Array.isArray(val.default) && val.default.length>0){
            firstMat = val.default[0];
            break;
          }
        }
      }
    }

    // helper to embed image if uploaded
    async function embedImageFromPath(pathOrName){
      if(!pathOrName) return null;
      const base = pathOrName.split('/').pop();
      // try to find exact filename in filesMap
      let u8 = filesMap[base] || filesMap[pathOrName] || filesMap[pathOrName.replace(/\//g, '_')];
      if(!u8){
        log("Texture not found for: " + pathOrName + " (buscando por basename: " + base + ")");
        return null;
      }
      // ensure Uint8Array
      if(!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);

      // append it using addPart (this will add bufferView at next index)
      const bvIndex = addPart(u8, undefined);
      // create image entry
      const mime = (base.toLowerCase().endsWith('.jpg') || base.toLowerCase().endsWith('.jpeg')) ? 'image/jpeg' : 'image/png';
      const imgIndex = images.length;
      images.push({bufferView: bvIndex, mimeType: mime});
      // create texture entry (source refers to image index)
      const texIndex = textures.length;
      textures.push({source: imgIndex});
      log("Texture embebida: " + base + " (bufferView " + bvIndex + ", len " + u8.byteLength + ")");
      return texIndex;
    }

    // embed textures referenced by material
    if(firstMat){
      // try map, normalMap, emissiveMap, specularMap
      const baseTexIdx = await embedImageFromPath(firstMat.map || firstMat.diffuse || firstMat.texture);
      const normalTexIdx = await embedImageFromPath(firstMat.normalMap || firstMat.normal);
      const emissiveTexIdx = await embedImageFromPath(firstMat.emissiveMap || firstMat.emissive);
      // We added bufferViews/textures/images to arrays; we'll reference them when building material
    }

    // finalize binBuffer
    const finalBin = concatArrayBuffers(binParts.map(p => p.buffer));

    // Create accessors - bufferView indices for geometry are bvPos, bvNorm, bvUV, bvIdx
    const countVertices = positions.length/3;
    const accessorPos = {
      bufferView: bvPos, byteOffset:0, componentType:5126, count:countVertices, type:"VEC3",
      min: [Math.min(...positions.filter((_,i)=>i%3===0)), Math.min(...positions.filter((_,i)=>i%3===1)), Math.min(...positions.filter((_,i)=>i%3===2))],
      max: [Math.max(...positions.filter((_,i)=>i%3===0)), Math.max(...positions.filter((_,i)=>i%3===1)), Math.max(...positions.filter((_,i)=>i%3===2))]
    };
    const accessorNorm = { bufferView: bvNorm, byteOffset:0, componentType:5126, count:countVertices, type:"VEC3" };
    const accessorUV = { bufferView: bvUV, byteOffset:0, componentType:5126, count:countVertices, type:"VEC2" };
    const accessorIdx = { bufferView: bvIdx, byteOffset:0, componentType: indexComponentType, count: indices.length, type:"SCALAR" };

    const accessorsArr = [accessorPos, accessorNorm, accessorUV, accessorIdx];

    // Create primitive(s) — viewer JSON had groups; we'll keep single primitive referencing entire index accessor
    const prim = {
      attributes: {"POSITION":0,"NORMAL":1,"TEXCOORD_0":2},
      indices: 3,
      mode: 4,
      material: 0   // <-- AQUÍ: asignar el material creado (índice 0)
    };

    // Create material from materialJson if available, else basic
    const gltfMaterials = [];
    let glMat = {
      pbrMetallicRoughness: {
        baseColorFactor: [1,1,1,1],
        metallicFactor: 0.0,
        roughnessFactor: 0.9
      },
      name: modelName + "_mat"
    };
    if(firstMat){
      // color integer -> convert to normalized rgba
      if(firstMat.color !== undefined){
        const c = firstMat.color >>> 0;
        const r = ((c>>16)&255)/255, g=((c>>8)&255)/255, b=(c&255)/255;
        glMat.pbrMetallicRoughness.baseColorFactor = [r,g,b,1.0];
      }
      // if we embedded textures, figure indexes: textures array appended after geometry textures
      if(typeof textures[0] !== 'undefined'){
        // we set textures earlier; base color was first if present
        glMat.pbrMetallicRoughness.baseColorTexture = { index: 0 };
      }
      // normal texture maybe next
      if(typeof textures[1] !== 'undefined'){
        glMat.normalTexture = { index: 1 };
      }
      if(typeof textures[2] !== 'undefined'){
        glMat.emissiveTexture = { index: 2 };
        glMat.emissiveFactor = [1,1,1];
      }
      // optionally combine specular/shininess into roughness, omitted for simplicity
    }

    gltfMaterials.push(glMat);

    // Build glTF JSON
    const gltf = {
      asset: { version: "2.0", generator:"gm3d-html-converter" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh:0, name: "root" }],
      meshes: [{ primitives: [ prim ], name: modelName }],
      buffers: [{ byteLength: finalBin.byteLength }],
      bufferViews: bufferViews,
      accessors: accessorsArr,
      materials: gltfMaterials
    };

    if(images.length>0) gltf.images = images;
    if(textures.length>0) gltf.textures = textures;

    // write GLB bytes
    const glbBytes = writeGLB(gltf, finalBin);
    log("GLB generado: " + glbBytes.byteLength + " bytes");

    // create download link
    const blob = new Blob([glbBytes], {type:'model/gltf-binary'});
    const url = URL.createObjectURL(blob);
    const dl = document.getElementById('downloadLink');
    dl.href = url;
    dl.download = modelName.replace(/\.[^.]+$/,'') + ".glb";
    dl.style.display = 'inline-block';
    dl.textContent = "Descargar " + dl.download;
    log("Listo. Pulsa 'Descargar' para bajar tu GLB.");
  } catch(err){
    console.error(err);
    log("Error: " + (err && err.message ? err.message : err));
  }
});
