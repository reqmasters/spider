import { NextRequest, NextResponse } from 'next/server';
import { PersonioClient } from '../../../../lib/personio';
import { renderToBuffer } from '@react-pdf/renderer';
import { Workbook, Worksheet } from 'exceljs';
import path from 'path';
import fs from 'fs/promises';
import IndividualReport from '../../../../components/IndividualReport';
import React from 'react';
import { format } from 'date-fns';
import { Document } from '@react-pdf/renderer';

const TEMPLATE_MAPPING = {
  '454242': 'Cariad_Template.xlsx',
  '2023124': 'Template_Scheuerle.xlsx',
  '2023129': 'Template_Scheuerle.xlsx',
  '2050275': 'Template_Scheuerle.xlsx',
  '2050276': 'Template_Scheuerle.xlsx',
  'default': 'Timesheet_Siemens_Vorlage.xlsx'
};

export async function POST(req: NextRequest) {
  try {
    const { projectId: projectName, startDate, endDate, format: outputFormat } = await req.json();
    console.log('Received request:', { projectName, startDate, endDate, outputFormat });

    if (!projectName || typeof projectName !== 'string') {
      throw new Error(`Invalid project name: ${projectName}`);
    }

    // Initialize Personio client
    const personioClient = new PersonioClient({
      clientId: process.env.PERSONIO_CLIENT_ID!,
      clientSecret: process.env.PERSONIO_CLIENT_SECRET!,
    });

    // Get project ID from name
    console.log('Fetching project ID for name:', projectName);
    const projectId = await personioClient.getProjectIdByName(projectName);
    if (!projectId) {
      throw new Error(`Project ID not found for name: ${projectName}`);
    }
    console.log('Found project ID:', projectId);

    // Get project attendances
    console.log('Fetching attendances for date range:', { startDate, endDate });
    const attendances = await personioClient.getAttendances(
      projectId,
      startDate,
      endDate,
      true
    );
    console.log(`Found ${attendances.length} attendance records`);

    // Sort attendances by date
    const sortedAttendances = attendances.sort((a, b) => 
      new Date(a.Date).getTime() - new Date(b.Date).getTime()
    );

    // Process attendance data
    const daysData = new Map();
    let totalHours = 0;

    sortedAttendances.forEach(attendance => {
      const day = new Date(attendance.Date).getDate();
      
      if (!daysData.has(day)) {
        daysData.set(day, {
          date: attendance.Date,
          hours: attendance.DurationNet,
          comments: attendance.Comment ? [attendance.Comment] : []
        });
      } else {
        const dayData = daysData.get(day);
        dayData.hours += attendance.DurationNet;
        if (attendance.Comment && !dayData.comments.includes(attendance.Comment)) {
          dayData.comments.push(attendance.Comment);
        }
      }
      
      totalHours += attendance.DurationNet;
    });

    console.log('Processed attendance data:', {
      totalDays: daysData.size,
      totalHours,
    });

    const cleanProjectName = projectName.substring(5);  // Remove "_ext_"

    if (outputFormat === 'xlsx') {
      // Handle Excel export
      const templateName = TEMPLATE_MAPPING[projectId.toString() as keyof typeof TEMPLATE_MAPPING] || TEMPLATE_MAPPING.default;
      const templatePath = path.join(process.cwd(), 'public', 'templates', templateName);
      
      console.log('Using Excel template:', templatePath);
      
      // Verify template exists
      try {
        const stats = await fs.stat(templatePath);
        if (!stats.isFile()) {
          throw new Error('Template path is not a file');
        }
        console.log('Template file stats:', stats);
      } catch (error) {
        console.error('Template access error:', error);
        throw new Error(`Excel template not found or inaccessible: ${templateName}`);
      }

      // Create new workbook and read template
      const workbook = new Workbook();
      
      try {
        let sheet!: Worksheet;
        
        if (templateName === 'Template_Scheuerle.xlsx') {
          // Read the template file for Scheuerle projects
          await workbook.xlsx.readFile(templatePath);
          const templateSheet = workbook.getWorksheet(1);
          if (!templateSheet) {
            throw new Error('Template worksheet not found');
          }
          sheet = templateSheet;
          
          // Add month and year
          const monthYear = new Date(startDate);
          sheet.getCell('C6').value = format(monthYear, 'MMMM');
          sheet.getCell('D6').value = format(monthYear, 'yyyy');

          // Get the first day of the month
          const firstDay = new Date(monthYear.getFullYear(), monthYear.getMonth(), 1);
          const daysInMonth = new Date(monthYear.getFullYear(), monthYear.getMonth() + 1, 0).getDate();

          // German day names
          const dayNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

          // Fill days from row 8 to 38
          for (let i = 0; i < 31; i++) {
            const currentDate = new Date(firstDay);
            currentDate.setDate(firstDay.getDate() + i);
            
            if (i < daysInMonth) {
              const rowNum = 8 + i;
              const dayOfWeek = currentDate.getDay();
              
              // Add day name
              sheet.getCell(`B${rowNum}`).value = dayNames[dayOfWeek === 0 ? 6 : dayOfWeek - 1];
              // Add date number (padded with zero if needed)
              sheet.getCell(`C${rowNum}`).value = String(currentDate.getDate()).padStart(2, '0');
              
              // Add hours and comments if we have data for this day
              const dayData = daysData.get(currentDate.getDate());
              if (dayData) {
                sheet.getCell(`D${rowNum}`).value = dayData.hours;
                sheet.getCell(`E${rowNum}`).value = dayData.comments.filter((c: string) => c).join(', ');
              }
            } else {
              // Clear remaining rows if month has less than 31 days
              sheet.getCell(`B${8 + i}`).value = '';
              sheet.getCell(`C${8 + i}`).value = '';
              sheet.getCell(`D${8 + i}`).value = '';
              sheet.getCell(`E${8 + i}`).value = '';
            }
          }
        } else {
          // Create a new workbook for projects without a template
          sheet = workbook.addWorksheet('Report');
          
          // Set up basic structure
          sheet.columns = [
            { header: 'Datum', key: 'date', width: 15 },
            { header: 'Stunden', key: 'hours', width: 10 },
            { header: 'Kommentare', key: 'comments', width: 50 }
          ];

          // Add data
          const rows = Array.from(daysData.values()).map(data => ({
            date: data.date,
            hours: data.hours,
            comments: data.comments.filter((c: string) => c).join(', ')
          }));

          sheet.addRows(rows);

          // Add total row
          sheet.addRow(['Total', totalHours, '']);

          // Style the worksheet
          sheet.getRow(1).font = { bold: true };
          sheet.getRow(sheet.rowCount).font = { bold: true };
        }

        // Set column widths for Scheuerle template
        if (templateName === 'Template_Scheuerle.xlsx') {
          sheet.getColumn('A').width = 5;  // Narrow column
          sheet.getColumn('B').width = 11;  // Day names (Mo, Di, etc)
          sheet.getColumn('C').width = 25;  // Day numbers
          sheet.getColumn('D').width = 10; // Hours
          sheet.getColumn('E').width = 100; // Comments - wide column
        }

        console.log('Worksheet created successfully');
      } catch (error) {
        console.error('Worksheet creation error:', error);
        throw new Error(`Failed to create worksheet: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Generate buffer
      try {
        const buffer = await workbook.xlsx.writeBuffer();
        console.log('Excel buffer generated successfully');

        const fileName = `${cleanProjectName}_${format(new Date(startDate), 'yyyy-MM')}.xlsx`;
        console.log('Generating Excel file:', fileName);

        return new NextResponse(buffer, {
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${fileName}"`,
          },
        });
      } catch (error) {
        console.error('Buffer generation error:', error);
        throw new Error(`Failed to generate Excel buffer: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

    } else {
      // Handle PDF export
      const reportData = {
        projectName: cleanProjectName,
        month: format(new Date(startDate), 'MMMM yyyy'),
        days: Array.from(daysData.values()),
        totalHours
      };

      console.log('Generating PDF with data:', reportData);

      // Create the PDF document
      const MyDocument = React.createElement(Document, {
        creator: 'Reqmastes',
        producer: 'Reqmastes PDF Generator',
        title: `Individualbericht - ${cleanProjectName}`,
      }, 
        React.createElement(IndividualReport, {
          ...reportData,
          key: 'individual-report'
        })
      );

      try {
        console.log('Starting PDF generation...');
        const pdfBuffer = await renderToBuffer(MyDocument);
        console.log('PDF buffer created successfully, size:', pdfBuffer.length);

        return new NextResponse(pdfBuffer, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${cleanProjectName}_${format(new Date(startDate), 'yyyy-MM')}.pdf"`,
          },
        });
      } catch (error) {
        console.error('PDF generation error:', error);
        throw new Error(`Failed to generate PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

  } catch (error) {
    console.error('Error generating individual report:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate individual report' },
      { status: 500 }
    );
  }
} 