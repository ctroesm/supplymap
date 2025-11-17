// src/App.js
import React, { useEffect, useMemo, useRef, useState, useCallback} from 'react';
import mapboxgl from 'mapbox-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ArcLayer, ScatterplotLayer, ColumnLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import Papa from 'papaparse';
import * as d3 from 'd3';

mapboxgl.accessToken =
  'pk.eyJ1IjoiY2hyeXN0aTAyMDIiLCJhIjoiY21lMHF4cmplMDYyNDJqcTE1cTNtc2tpayJ9.Qjo1kSCg3d2J-XyRXkzKmQ';

// 🔹 불러올 CSV 파일들 (public/data/ 경로)
const CSV_FILES = ['data1.csv', 'data2.csv', 'data3.csv', 'data4.csv', 'data5.csv'];

// 🔹 지도 초기 뷰
const INITIAL_VIEW_STATE = {
  longitude: 128.6,
  latitude: 35.3,
  zoom: 4,
  pitch: 0,
  bearing: 0
};

// 🔹 금액(매출) 컬럼명
const SALES_COL = 'Sales';

export default function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);

  // deck layer refs (clone 업데이트용)
  const arcLayerRef = useRef(null);
  const scatterLayerRef = useRef(null);
  const columnLayerRef = useRef(null);

  // 데이터 상태
  const [allData, setAllData] = useState({}); // {fileName: rows[]}
  const [headerOrder, setHeaderOrder] = useState([]); // 첫 로드한 CSV의 열 순서 저장

  // 토글 상태
  const [visibleFiles, setVisibleFiles] = useState(
    CSV_FILES.reduce((acc, f) => ({ ...acc, [f]: true }), {})
  );
  const [visibleLayers, setVisibleLayers] = useState({
    arc: true,
    scatter: true,
    column: true
  });

  // 검색/필터/슬라이더
  const [searchText, setSearchText] = useState('');
  // 열별 필터: { columnName: { mode:'text'|'select', values: string[] } }
  const [columnFilters, setColumnFilters] = useState({});
  // 금액 필터(슬라이더/숫자입력용 범위)
  const [amountMinMax, setAmountMinMax] = useState([0, 100]); // 실제 데이터 min/max
  const [amountRange, setAmountRange] = useState([0, 100]);   // 초기엔 동일하게

  useEffect(() => {
    setAmountRange(prev => {
      // 아직 기본값([0,100]) 상태라면 min/max로 갱신
      if (prev[0] === 0 && prev[1] === 100) {
        return amountMinMax;
      }
      return prev; // 이미 사용자가 움직였으면 유지
    });
  }, [amountMinMax]);

  // 마우스 오버 시 툴팁 표시용 state
  const [hoveredPoint] = useState(null);
  
  // 툴팁
  const [hoverInfo, setHoverInfo] = useState(null); // {x,y, ...row, type}
  const [selectedPoint, setSelectedPoint] = useState(null); // 클릭 고정용

  // 🔹 CSV 로딩
  useEffect(() => {
    const fetchCSVs = async () => {
      try {
        const allResults = await Promise.all(
          CSV_FILES.map(file => 
            fetch(`${process.env.PUBLIC_URL}/data/${file}?v=${Date.now()}`)
              .then(r => r.text())
              .then(text =>
                new Promise(resolve => {
                  Papa.parse(text, {
                    header: true,
                    dynamicTyping: true,
                    skipEmptyLines: true,
                    complete: results => {
                      if (results.errors?.length) {
                        console.error(`${file} 파싱 오류`, results.errors);
                      }
                      resolve({ file, rows: results.data || [] });
                    }
                  });
                })
              )
          )
        );

        const dataObj = {};
        allResults.forEach(({ file, rows }, idx) => {
          dataObj[file] = rows;
          if (idx === 0 && rows.length) {
            setHeaderOrder(Object.keys(rows[0]));
          }
        });
        setAllData(dataObj);
      } catch (err) {
        console.error('CSV 로드 실패', err);
      }
    };

    fetchCSVs();
  }, []);


  // 🔹 데이터 결합 + 필터
  const combinedData = useMemo(() => {
    // 파일 토글 반영
    let rows = [];
    for (const f of CSV_FILES) {
      if (visibleFiles[f] && allData[f]) rows = rows.concat(allData[f]);
    }

    // 금액 범위 원시 min/max 갱신
    if (rows.length) {
      const vals = rows.map(d => Number(d[SALES_COL]) || 0);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        // 초기 설정만 한 번 맞춘다 (데이터가 변할 때마다 과도하게 흔들리지 않도록)
        if (amountMinMax[0] !== min || amountMinMax[1] !== max) {
          setAmountMinMax([min, max]);
          // amountRange 초기화(처음에만 크게 벗어나 있으면 보정)
          if (amountRange[0] < min || amountRange[1] > max) {
            setAmountRange([min, max]);
          }
        }
      }
    }

    // 금액 슬라이더 필터
    rows = rows.filter(d => {
      const v = Number(d[SALES_COL]) || 0;
      return v >= amountRange[0] && v <= amountRange[1];
    });

    // 열별 필터
    for (const [col, cfg] of Object.entries(columnFilters)) {
      if (!cfg || !cfg.values || cfg.values.length === 0) continue;
      if (cfg.mode === 'text') {
        // OR 검색 (대소문자 무시)
        const needles = cfg.values
          .map(s => (s ?? '').toString().trim().toLowerCase())
          .filter(Boolean);
        if (needles.length) {
          rows = rows.filter(row =>
            needles.some(needle =>
              (row[col] ?? '')
                .toString()
                .toLowerCase()
                .includes(needle)
            )
          );
        }
      } else if (cfg.mode === 'select') {
        // 드롭다운 다중 선택 (값 일치)
        const vals = new Set(cfg.values.map(v => (v ?? '').toString()));
        rows = rows.filter(row => vals.has((row[col] ?? '').toString()));
      }
    }

    // 🔹 전체 검색 (모든 열, 대소문자 무시)
    const keyword = searchText.trim().toLowerCase();
    if (keyword) {
      // 공백 단위로 여러 단어로 나누어 모든 단어 포함 확인
      const parts = keyword.split(":");

      if (parts.length === 2) {
        // 🔹 특정 열:검색어 형태
        const col = parts[0]; // e.g. "code"
        const term = parts[1];

        rows = rows.filter(row =>
          Object.entries(row).some(([key, value]) =>
            key.toLowerCase().includes(col) &&
            (value ?? '').toString().toLowerCase().includes(term)
          )
        );
      } else {
        // 🔹 일반 검색 (모든 열)
        const terms = keyword.split(/\s+/).filter(Boolean);

        rows = rows.filter(row =>
          terms.every(term =>
            Object.values(row).some(v =>
              (v ?? '').toString().toLowerCase().includes(term)
            )
          )
        );
      }
    }

    return rows;
  }, [allData, visibleFiles, columnFilters, searchText, amountRange, amountMinMax]);

  // 🔹 고유값 목록 (드롭다운용)
  const uniqueValuesByCol = useMemo(() => {
    const dict = {};
    for (const col of headerOrder) {
      const set = new Set();
      combinedData.forEach(r => set.add((r[col] ?? '').toString()));
      dict[col] = Array.from(set).filter(v => v !== '');
    }
    return dict;
  }, [combinedData, headerOrder]);

  // 🔹 Mapbox + Deck 초기화
  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
      center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
      zoom: INITIAL_VIEW_STATE.zoom,
      pitch: INITIAL_VIEW_STATE.pitch,
      bearing: INITIAL_VIEW_STATE.bearing,
    });
    mapRef.current = map;
    map.on('click', (event) => {
      const features = map.queryRenderedFeatures(event.point);
      if (features.length) {
        // 클릭한 feature가 있으면 선택/고정
        setSelectedPoint(features[0]);
      } else {
        // 클릭한 위치에 object가 없으면 hover/selected 초기화
        setHoverInfo(null);
        setSelectedPoint(null);
      }
    });
  
    // 초기 레이어
    arcLayerRef.current = new ArcLayer({ id: 'arc-layer', data: [] });
    scatterLayerRef.current = new ScatterplotLayer({ id: 'scatter-layer', data: [] });
    columnLayerRef.current = new ColumnLayer({ id: 'column-layer', data: [] });

    const overlay = new MapboxOverlay({
      layers: [scatterLayerRef.current, arcLayerRef.current, columnLayerRef.current]
    });
    overlayRef.current = overlay;
    map.addControl(overlay);

    // 맵 클릭: 선택 해제(클릭 외부)
    map.on('click', () => setSelectedPoint(null));

    return () => map.remove();
  }, []);

  // 🔹 스케일(로그) 계산
  const scales = useMemo(() => {
    const vals = combinedData.map(d => Number(d[SALES_COL]) || 0).filter(v => v >= 0);
    const minSales = Math.min(...vals);
    const maxSales = Math.max(...vals);


    const positiveVals = vals.filter(v => v > 0);
    const minPos = positiveVals.length ? Math.min(...positiveVals) : 1;
    const maxVal = vals.length ? Math.max(...vals) : 1;

    const domainMin = Math.min(minPos, 1); // 0이나 너무 작은 값 보호
    const domainMax = Math.max(maxVal, 1);

    // 선 굵기: 1~10px
    const widthScale = d3.scaleLog().domain([domainMin, domainMax]).range([1, 3]).clamp(true);

    // 점 크기: 10km ~ 30km (meters)
    const pointRadiusScale = d3.scaleLog()
      .domain([domainMin, domainMax])
      .range([10000, 30000])
      .clamp(true);

    // 원기둥 높이&넓이
    const columnHeightScale = d3.scaleLinear()
      .domain([minSales, maxSales])
      .range([10000, 300000]) // 최대 200m 정도로 제한
      .clamp(true);
    const columnRadiusScale = d3.scaleSqrt()
      .domain([domainMin, domainMax])
      .range([10000000, 10000000])
      .clamp(true);
  
    // 🔹 색상 스케일 (Spectral, 높은 값 → 빨강, 낮은 값 → 파랑)
    const colorScale = d3.scaleSequential(t => {
      const c = d3.rgb(d3.interpolateRdYlBu((0.1 + t * 0.8)));
      return [c.r, c.g, c.b, 200]; // ✅ deck.gl용 [r,g,b,a]
    }).domain([domainMax, domainMin]); // domain 반전

    return { widthScale, pointRadiusScale, columnHeightScale, columnRadiusScale, colorScale, domainMin, domainMax };
}, [combinedData]);

  // 🔹 Deck 레이어 업데이트
  useEffect(() => {
    if (!overlayRef.current) return;

    // 좌표 유효성
    const hasCoords = d =>
      Number.isFinite(Number(d['Source Lat'])) &&
      Number.isFinite(Number(d['Source Lng'])) &&
      Number.isFinite(Number(d['Target Lat'])) &&
      Number.isFinite(Number(d['Target Lng']));

    const v = x => (Number(x) > 0 ? Number(x) : scales.domainMin); // 0 보호

    const arcData = combinedData.filter(d => hasCoords(d));
    const scatterData = combinedData.filter(
      d => Number.isFinite(Number(d['Target Lat'])) && Number.isFinite(Number(d['Target Lng']))
    );
    const columnData = scatterData; // 타겟 위치에 원기둥

    // Arc
    const nextArc = new ArcLayer({
      id: 'arc-layer',
      data: visibleLayers.arc ? arcData : [],
      pickable: true,
      getSourcePosition: d => [Number(d['Source Lng']), Number(d['Source Lat'])],
      getTargetPosition: d => [Number(d['Target Lng']), Number(d['Target Lat'])],
      getWidth: d => scales.widthScale(v(d[SALES_COL])),
      getHeight: d => 0.5,
      getSourceColor: d => scales.colorScale(v(d[SALES_COL])),
      getTargetColor: d => scales.colorScale(v(d[SALES_COL])),
      fp64: true,
      parameters: { depthTest: false },
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT, // 또는 CARTESIAN 시도
      pickingRadius: 10,
      wrapLongitude: true,
      onHover: info =>
        !selectedPoint &&
        setHoverInfo(info.object ? { ...info.object, type: 'arc', x: info.x, y: info.y } : null)
    });

    // 데이터 min/max 계산
    const allSalesValues = [...scatterData, ...columnData].map(d => v(d[SALES_COL]));
    const minSales = Math.min(...allSalesValues);
    const maxSales = Math.max(...allSalesValues);
    
    // Scatter용 pixel 스케일
    const pointRadiusScale = d3.scaleSqrt()
    .domain([minSales, maxSales])
    .range([2, 12]); // 화면에서 점의 최소/최대 픽셀 반지름

    // Scatter (타겟점)
    const nextScatter = new ScatterplotLayer({
      id: 'scatter-layer',
      data: visibleLayers.scatter ? scatterData : [],
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: d => [Number(d['Target Lng']), Number(d['Target Lat'])],
      getRadius: d => pointRadiusScale(v(d[SALES_COL])),
      getFillColor: d => scales.colorScale(v(d[SALES_COL])),
      parameters: { depthTest: false },
      wrapLongitude: true,
      onHover: info =>
        !selectedPoint &&
        setHoverInfo(info.object ? { ...info.object, type: 'point', x: info.x, y: info.y } : null),
      onClick: info => {
        if (info?.object) {
          info.event?.stopPropagation();
          setSelectedPoint({ ...info.object, type: 'point', x: info.x, y: info.y });
        } else {
          setHoverInfo(null);   // 툴팁 제거
          setSelectedPoint(null);
        }
      }
    });
  
    // Column (원기둥, 타겟 위치)
    const nextColumn = new ColumnLayer({
      id: 'column-layer',
      data: visibleLayers.column ? columnData : [],
      pickable: true,
      diskResolution: 12,
      radiusUnits: 'meters',
      extruded: true,
      radius: 20000,
      elevationScale: 1,
      coverage: 1,
      getPosition: d => [Number(d['Target Lng']), Number(d['Target Lat'])],
      getElevation: d => scales.columnHeightScale(v(d[SALES_COL])) * 2,
      getFillColor: d => scales.colorScale(v(d[SALES_COL])),
      parameters: { depthTest: false },
      wrapLongitude: true,
      onHover: info =>
        !selectedPoint &&
        setHoverInfo(info.object ? { ...info.object, type: 'column', x: info.x, y: info.y } : null),
      onClick: info => {
        if (info?.object) {
          info.event?.stopPropagation();
          const pointWithCoords = { ...info.object, x: info.x, y: info.y };
          if (selectedPoint?.id === info.object.id) setSelectedPoint(null);
          else setSelectedPoint(pointWithCoords);
        } else {
          setSelectedPoint(null);
        }
      }
    });


    arcLayerRef.current = nextArc;
    scatterLayerRef.current = nextScatter;
    columnLayerRef.current = nextColumn;

    // 안전하게 overlayRef.current에 props 적용
    if (overlayRef.current) {
      overlayRef.current.setProps({
        layers: [nextScatter, nextArc, nextColumn],
        parameters: {
          depthRange: [0, 1],
          nearZMultiplier: 0.00000001,
          farZMultiplier: 10.0,
        },
      });
    }

    overlayRef.current.setProps({
      layers: [nextScatter, nextArc, nextColumn] // 툴팁 위계상 문제 없게 순서 유지
    });
  }, [combinedData, scales, visibleLayers, selectedPoint]);

  // 🔹 툴팁 데이터 (클릭 고정 우선)
  const tooltipInfo = selectedPoint || hoverInfo;

  // 🔹 툴팁 테이블: CSV 열 순서대로, 금액 열은 값 0/빈칸이면 제외
  const tooltipRows = useMemo(() => {
    if (!tooltipInfo) return [];
    const row = tooltipInfo;

    // 표시 제외 키
    const hiddenKeys = new Set(['x', 'y', 'type']);

    // CSV 순서 기준
    const cols = headerOrder.length ? headerOrder : Object.keys(row);
    const main = [];

    for (const key of cols) {
      if (hiddenKeys.has(key)) continue;
      if (!(key in row)) continue;

      main.push([key, row[key]]);
    }

    // 금액 컬럼을 뒤쪽에
    return main;
  }, [tooltipInfo, headerOrder]);

  // 🔹 UI 핸들러
  const toggleLayer = k => setVisibleLayers(prev => ({ ...prev, [k]: !prev[k] }));

  // 🔹 열별 필터 추가/갱신
  const upsertColumnFilter = (col, mode, rawValue) => {
    // 콤마로 다중 입력 지원
    const values = (rawValue ?? '')
      .toString()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    setColumnFilters(prev => ({
      ...prev,
      [col]: { mode, values }
    }));
  };

  // 🔹 필터 UI 스타일
  const panelStyle = {
    position: 'absolute',
    top: 10,
    left: 10,
    zIndex: 10,
    background: 'rgba(0,0,0,0.75)',
    color: 'white',
    padding: 10,
    borderRadius: 6,
    width: '100%',       // 화면에 맞춤
    maxWidth: 360,                 // 최대폭 제한
    maxHeight: '80vh',
    overflowX: 'hidden',
    overflowY: 'auto',
    boxShadow: '0 2px 10px rgba(0,0,0,0.35)'
  };

  return (
    <>
      <div style={panelStyle}>
        {/* 🔹 Search */}
        <h3 style={{ margin: '12px 0 6px' }}>Search</h3>
        <input
          type="text"
          placeholder="ex) Ford  or  Code:287504"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.1)',
            color: 'white',
            boxSizing: 'border-box'  // 🔹 추가
          }}
        />
        
        {/* 🔹 Filters */}
        <h3 style={{ margin: '12px 0 6px' }}>Filters</h3>
        {/* 간소화된 Kepler 스타일: 열 선택 → 모드 선택 → 값 입력(텍스트 OR 드롭다운 다중) */}
        {headerOrder.length > 0 && (
          <ColumnFilterUI
            headerOrder={headerOrder}
            uniqueValuesByCol={uniqueValuesByCol}
            columnFilters={columnFilters}
            onChange={upsertColumnFilter}
          />
        )}

        {/* 🔹 Sales Slider */}
        <h3 style={{ margin: '12px 0 6px' }}>Sales</h3>
        <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 6 }}>
          Range: {amountRange[0]} ~ {amountRange[1]} (min: {amountMinMax[0]}, max: {amountMinMax[1]})
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            value={amountRange[0]}
            min={amountMinMax[0]}
            max={amountRange[1]}
            onChange={e =>
              setAmountRange([Number(e.target.value), amountRange[1]])
            }
            style={{ width: '45%', padding: 6, borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: 'white' }}
          />
          <input
            type="number"
            value={amountRange[1]}
            min={amountRange[0]}
            max={amountMinMax[1]}
            onChange={e =>
              setAmountRange([amountRange[0], Number(e.target.value)])
            }
            style={{ width: '45%', padding: 6, borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: 'white' }}
          />
        </div>
        {/* 간단 슬라이더 2개로 구현(범위): 필요하면 커스텀 Range Slider로 교체 가능 */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input
            type="range"
            min={amountMinMax[0]}
            max={amountMinMax[1]}
            step="0.01"
            value={amountRange[0]}
            onChange={e =>
              setAmountRange([Number(e.target.value), amountRange[1]])
            }
            style={{ flex: 1 }}
          />
          <input
            type="range"
            min={amountMinMax[0]}
            max={amountMinMax[1]}
            step="0.01"
            value={amountRange[1]}
            onChange={e =>
              setAmountRange([amountRange[0], Number(e.target.value)])
            }
            style={{ flex: 1 }}
          />
        </div>

        {/* 🔹 Layers */}
        <h3 style={{ margin: '12px 0 6px' }}>Layers</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={visibleLayers.arc}
              onChange={() => toggleLayer('arc')}
            />
            <span>Arc</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={visibleLayers.scatter}
              onChange={() => toggleLayer('scatter')}
            />
            <span>Scatter</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={visibleLayers.column}
              onChange={() => toggleLayer('column')}
            />
            <span>Column</span>
          </label>
        </div>

        {/* Reset 버튼 */}
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button
            onClick={() => {
              setSearchText('');
              setColumnFilters({});
              setAmountRange(amountMinMax);
            }}
            style={{
              padding: '6px 10px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.3)',
              background: 'rgba(255,255,255,0.08)',
              color: 'white'
            }}
          >
            Reset All
          </button>
        </div>
      </div>

      {/* 🔹 지도 컨테이너 */}
      <div ref={mapContainerRef} style={{ width: '100vw', height: '100vh' }} />

      {/* 🔹 색 범례 */}
      {scales && (
        <div
          style={{
            position: 'absolute',
            right: 10,
            top: 20,
            padding: 6,
            background: 'rgba(0,0,0,0.5)',
            borderRadius: 6,
            color: 'white',
            fontSize: 12,
            zIndex: 999,
          }}
        >
          <div
            style={{
              position: 'relative',
              width: '200px',
              height: '30px',
              border: '0px solid rgba(255,255,255,0.3)',
              borderRadius: 4,
              background: `linear-gradient(to left, ${[...Array(100)].map((_, i) => {
                const t = i / 99;
                const c = d3.rgb(d3.interpolateRdYlBu(0.1 + t * 0.8));
                return `rgb(${c.r},${c.g},${c.b}) ${t * 100}%`;
              }).join(', ')})`
            }}
          >
            <span style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', fontSize: 14 }}>
              {scales.domainMin.toLocaleString()}
            </span>
            <span style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', fontSize: 14 }}>
              {scales.domainMax.toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {/* 🔹 툴팁 표시 */}
      {(hoveredPoint || selectedPoint) && (
        <div
          style={{
            position: 'absolute',
            pointerEvents: 'auto', // 복사 가능
            left: (selectedPoint?.x || hoveredPoint?.x) + 10,
            top: (selectedPoint?.y || hoveredPoint?.y) + 10,
            background: 'white',
            padding: 8,
            borderRadius: 4,
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            fontSize: 13,
            userSelect: 'text', // ← 텍스트 선택 허용
          }}
        >
        </div>
      )}
      

      {/* 🔹 툴팁 (항상 최상단) */}
      {tooltipInfo && tooltipRows.length > 0 && (
        <div
          style={{
            position: 'absolute',
            pointerEvents: 'auto',
            left: tooltipInfo.x ?? 0,
            top: tooltipInfo.y ?? 0,
            transform: 'translate(12px, 12px)',
            zIndex: 9999, // 레이어보다 위
            backgroundColor: 'rgba(0,0,0,0.85)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 13,
            maxWidth: 420,
            userSelect: 'text', // ← 텍스트 선택 허용
          }}
        >
          <table style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {tooltipRows.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ textAlign: 'left', paddingRight: 10, opacity: 0.9 }}>{k}</td>
                  <td style={{ textAlign: 'right' }}>{v?.toString?.() ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {selectedPoint && (
            <div style={{ marginTop: 6, textAlign: 'right', opacity: 0.85 }}>
              <button
                onClick={() => {
                  setSelectedPoint(null);  // 선택 해제
                  setHoverInfo(null);      // 툴팁 제거
                }}
                style={{ /* 스타일 */ }}
              >
                Click map or here to dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** ===== 간소화된 Column Filter UI =====
 * - 열 선택
 * - 모드 선택(text or select)
 * - 값 입력(텍스트는 콤마로 다중 OR, 드롭다운은 다중 선택)
 */

function ColumnFilterUI({ headerOrder, uniqueValuesByCol, columnFilters, onChange }) {
  const [selectedCol, setSelectedCol] = useState(headerOrder[0] || '');
  
  // 메인 입력 및 검색어 상태 (사용자가 현재 입력 중인 값)
  const [searchTerm, setSearchTerm] = useState(''); 
  
  // 자동완성 드롭다운에서 선택된 값 목록
  const [selectValues, setSelectValues] = useState([]);

  const [showDropdown, setShowDropdown] = useState(false);

  // 선택된 컬럼이나 기존 필터가 변경될 때 상태 초기화 및 로드
  useEffect(() => {
    const cfg = columnFilters[selectedCol];
    
    // 컬럼 변경 시 무조건 검색어 초기화 (새 컬럼에 집중)
    setSearchTerm(''); 

    if (!cfg) {
      setSelectValues([]);
      return;
    }

    // 기존 필터 로드
    if (cfg.mode === 'select') {
      // select 모드: 이전에 선택했던 값들을 로드
      setSelectValues(cfg.values || []);
    } else if (cfg.mode === 'text') {
      // text 모드: 이전에 입력했던 텍스트를 검색어 필드에 로드
      // *주의: text 모드에서는 selectValues는 비워둡니다.*
      setSelectValues([]);
      setSearchTerm(cfg.values.join(', '));
    } else {
      setSelectValues([]);
    }
    
  }, [selectedCol, columnFilters]);

  const apply = useCallback(() => {
    // 1. selectValues에 값이 있으면, "선택 모드"로 간주하고 적용
    if (selectValues.length > 0) {
      // select mode: 선택된 값들을 쉼표로 연결하여 적용
      onChange(selectedCol, 'select', selectValues.join(','));
    } 
    // 2. selectValues가 비어있고, searchTerm에 값이 있으면, "텍스트 모드"로 간주하고 적용
    else if (searchTerm.trim() !== '') {
      // text mode: 입력된 텍스트 전체를 값으로 적용
      onChange(selectedCol, 'text', searchTerm.trim());
    } 
    // 3. 모두 비어있으면, 필터 해제
    else {
      onChange(selectedCol, null, null); // 필터 해제 로직을 가정
    }
  }, [selectedCol, selectValues, searchTerm, onChange]);

  // 드롭다운 항목 클릭 핸들러 (selectValues 토글)
  const toggleSelectOption = (v) => {
    setSelectValues(prev => {
      // 토글 로직: 있으면 제거, 없으면 추가
      const next = prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v];
      
      // 항목을 선택/해제하면 검색어 필드는 초기화
      // (사용자는 이제 선택된 목록을 보고 필터를 적용하려 할 것)
      setSearchTerm(''); 
      return next;
    });
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {/* Column 선택 */}
      <div>
        <div style={{ fontSize: 12, marginBottom: 4, opacity: 0.9 }}>Column</div>
        <select
          value={selectedCol}
          onChange={e => setSelectedCol(e.target.value)}
          style={{
            width: '100%',
            padding: 6,
            borderRadius: 4,
            background: 'rgba(80,80,80,80.75)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.25)'
          }}
        >
          {headerOrder.map(col => (
            <option key={col} value={col}>{col}</option>
          ))}
        </select>
      </div>

      {/* Values (텍스트 입력 & 자동완성 선택 공용) */}
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: 12, marginBottom: 4, opacity: 0.9 }}>Values</div>
        <input
          type="text"
          placeholder="Type to search or enter text filter (e.g., A, B, C)..."
          value={searchTerm}
          // 사용자가 입력할 때 selectValues를 비워야 텍스트 필터가 작동할 수 있으므로,
          // 입력이 시작되면 선택 목록을 초기화하는 것을 고려할 수 있습니다.
          // 여기서는 복잡도를 낮추기 위해 apply에서 우선순위를 주었습니다.
          onChange={e => setSearchTerm(e.target.value)}
          onFocus={() => setShowDropdown(true)}       // 클릭 시 열기
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)} // 포커스 벗어나면 닫기 (클릭 이벤트 처리 후 닫히게 약간 지연)
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.1)',
            color: 'white',
            boxSizing: 'border-box'
          }}
        />

        {/* 드롭다운 */}
        {showDropdown && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              width: '100%',
              maxHeight: 180,
              overflowY: 'auto',
              background: 'rgba(0,0,0,0.9)',
              color: 'white',
              borderRadius: 6,
              boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
              zIndex: 1000,
              marginTop: 2
            }}
          >
            {(uniqueValuesByCol[selectedCol] || [])
              .filter(v => String(v).toLowerCase().includes(searchTerm.toLowerCase()))
              .map(v => (
            <div
              key={v}
              onClick={() => toggleSelectOption(v)} // 항목 클릭 시 selectValues에 추가/제거
              style={{
                padding: '6px 8px',
                cursor: 'pointer',
                // 선택된 값은 하이라이트
                background: selectValues.includes(v)
                  ? 'rgba(255,255,255,0.2)'
                  : 'transparent'
              }}
            >
              {v}
            </div>
              ))}
          </div>
        )}
        
        {/* 현재 적용될 필터 값 표시 */}
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
          {selectValues.length > 0 
            ? `Selected Values: ${selectValues.join(', ')}`
            : searchTerm.trim() !== '' 
              ? `Text Filter: "${searchTerm.trim()}"`
              : 'No filter applied.'}
        </div>
        
        {/* Apply Filter */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            onClick={apply}
            style={{
              padding: '6px 10px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.3)',
              background: 'rgba(80,80,80,0.75)',
              color: 'white'
            }}
          >
            Apply
          </button>

          <button
            onClick={() => {
              setSearchTerm("");
              setSelectValues([]);
              // 필요하다면 필터 적용 로직 초기화도 추가 가능
              
              // 2) 부모 필터 해제 (columnFilters에서 해당 컬럼 제거)
              // onChange은 props로 받은 upsertColumnFilter 함수임
              onChange(selectedCol, null, null);
            }}
            style={{
              padding: '6px 10px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.3)',
              background: 'rgba(80,80,80,0.75)',
              color: 'white'
            }}
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

export { ColumnFilterUI };

