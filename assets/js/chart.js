import * as echarts from 'echarts';

defaultHeightVH = 20;

function between(x, min, max) {
  return x >= min && x <= max;
}

function parseTable(markdownTable) {
  if (!markdownTable) {
    return null;
  }

  const lines = markdownTable.trim().split('\n');
  if (lines.length < 2) {
    return null; // Not a valid table
  }

  const headerRow = lines[0].trim();
  const separatorRow = lines[1].trim();

  if (!headerRow.startsWith('|') || !separatorRow.startsWith('|')) {
    return null; // Not a valid table
  }

  const headers = headerRow
    .split('|')
    .map((header) => header.trim())
    .filter((header) => header !== '');

  const dataRows = lines.slice(2);
  const columns = {};

  headers.forEach(header => {
      columns[header] = [];
  });

  for (const row of dataRows) {
    const values = row
      .split('|')
      .map((value) => value.trim())
      .filter((value) => value !== '');

    if (values.length !== headers.length) {
      continue; // Skip rows with incorrect number of columns
    }

    for (let i = 0; i < headers.length; i++) {
      columns[headers[i]].push(values[i]);
    }
  }

  return columns;
}

export function initializeChart(options) {
  document.querySelectorAll('pre.chart').forEach(data => {
    let md = data.innerHTML;
    const lines = md.trim().split('\n');
    let tableOptions
    if (lines[0].startsWith("#")) {
      tableOptions = JSON.parse(lines[0].substring(lines[0].indexOf('#') + 1).trim())
      md = lines.slice(1).join("\n")
    }
    const json = parseTable(md)
    options = {...options, ...tableOptions}
    setupChart(data, json, options)
  });
}

function setupChart(element, data, options) {
  let animationDuration = 2000;
  const xAxisName = Object.keys(data)[0]
  const xAxisData = data[xAxisName];
  let series = [];
  let min, max;
  let seriesType = 'line'
  if ("type" in options) {
    seriesType = options.type
  }
  Object.keys(data).slice(1).forEach(key => {
    const values = data[key];
    const seriesMin = Math.min(...(values.filter(element => element !== '-')))
    const seriesMax = Math.max(...(values.filter(element => element !== '-')))
    let s = {data: values, type: seriesType, label: key, showSymbol: false, silent: true, connectNulls: true}
    if (("series" in options) && (key in options.series)) {
      s = {...s, ...options.series[key]}
    }
    series.push(s)
    if (seriesMin < min || min === undefined) {
      min = seriesMin
    }
    if (seriesMax > max || max === undefined) {
      max = seriesMax
    }
  });

  if ("duration" in options) {
    animationDuration = duration
  }

  if ("scale" in options && options.scale == true) {
    const factor = Math.pow(10, max.toString().length - 2)
    min = Math.floor(min / factor) * factor
    max = Math.ceil(max / factor) * factor
  } else {
    min = undefined
    max = undefined
  }

  let type = 'category'
  if (between(xAxisData[0], 1800, 2100) && between(xAxisData[xAxisData.length - 1], 1800, 2100)) {
    //type = 'time'
  }

  chartOptions = {
    xAxis: {
      type: type,
      label: xAxisName,
      data: xAxisData
    },
    grid: {
      left: 60,
      right: 10,
      top: 20,
      bottom: '10%'
    },
    yAxis: {
      type: 'value',
      min: min,
      max: max
    },
    series: series,
    animationDuration: animationDuration
  };

  if ("font" in options) {
    chartOptions["textStyle"] = {
      fontFamily: options.font
    }
  }

  const container = element.parentElement.querySelector('.chart-container');
  const [width, height] = getSize(container);
  let chart = echarts.init(container, null, { renderer: "svg", width: width, height: height});
  chart.setOption(chartOptions);
}

function getSize(container) {
  let width = container.offsetWidth;
  if (width === 0) {
    width = container.parentElement.parentElement.offsetWidth;
  }
  let height = container.offsetHeight;
  if (height === 0) {
    height = Math.round(window.innerHeight / 100) * defaultHeightVH;
  }
  return [width, height]
}
